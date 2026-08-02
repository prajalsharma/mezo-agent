// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {FeeRouter, Route, IVeloRouter} from "../src/FeeRouter.sol";

contract MockERC20 {
    string public name = "Mock";
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "bal");
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "bal");
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// Mock Velodrome router: pulls `amountIn` of routes[0].from, pays 2x out in
/// the same token to `to` (rate irrelevant — we test plumbing, not pricing).
contract MockRouter {
    MockERC20 public immutable tokenOut;
    bool public revertOnSwap;

    constructor(MockERC20 out_) { tokenOut = out_; }
    function setRevert(bool v) external { revertOnSwap = v; }

    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, address to, uint256
    ) external returns (uint256[] memory amounts) {
        require(!revertOnSwap, "router: revert");
        MockERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * 2;
        require(out >= amountOutMin, "slippage");
        tokenOut.mint(to, out);
        amounts = new uint256[](2);
        amounts[0] = amountIn; amounts[1] = out;
    }
}

contract FeeRouterTest is Test {
    MockERC20 tokenIn;
    MockERC20 tokenOut;
    MockRouter router;
    FeeRouter fr;

    address user = address(0xBEEF);
    address operator = address(0xFEE);
    address referrer = address(0xAF11);

    function setUp() public {
        tokenIn = new MockERC20();
        tokenOut = new MockERC20();
        router = new MockRouter(tokenOut);
        fr = new FeeRouter(address(router), operator, 50, 3000); // 0.5% fee, 30% max referral
        address[] memory refs = new address[](1);
        refs[0] = user;
        fr.bindReferrers(refs, referrer); // trader must be BOUND to this referrer
        address[] memory fts = new address[](1);
        fts[0] = address(tokenIn);
        fr.setFeeTokens(fts, true); // the fee's UNIT must be an approved token
        tokenIn.mint(user, 1_000e18);
        vm.prank(user);
        tokenIn.approve(address(fr), type(uint256).max);
    }

    function _routes() internal view returns (Route[] memory r) {
        r = new Route[](1);
        r[0] = Route({from: address(tokenIn), to: address(tokenOut), stable: false, factory: address(0xFAC)});
    }

    function test_feeCollectedAtomically() public {
        vm.prank(user);
        uint256 out = fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 0);
        // fee = 0.5% of 100 = 0.5; net = 99.5 swapped at 2x
        assertEq(tokenIn.balanceOf(operator), 0.5e18, "operator fee");
        assertEq(out, 199e18, "amountOut");
        assertEq(tokenOut.balanceOf(user), 199e18, "user got output DIRECTLY");
        assertEq(tokenIn.balanceOf(address(fr)), 0, "escrowless: nothing retained");
    }

    function test_referralSplitAtSource() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, referrer, 3000, 0);
        // Attested referral is CHARGED the discounted 45 bps (not the 50 headline):
        // fee 0.45; referrer 30% = 0.135; operator 0.315.
        assertEq(tokenIn.balanceOf(referrer), 0.135e18, "referrer 30% of the discounted fee");
        assertEq(tokenIn.balanceOf(operator), 0.315e18, "operator 70% of the discounted fee");
    }

    function test_referralShareClampedToMax() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, referrer, 9000, 0); // asks 90%
        assertEq(tokenIn.balanceOf(referrer), 0.135e18, "clamped to 30% of the discounted fee");
    }

    /// THE property this contract exists for: swap fails => fee reverts too.
    function test_atomic_noFeeOnFailedSwap() public {
        router.setRevert(true);
        vm.prank(user);
        vm.expectRevert(bytes("router: revert"));
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 0);
        assertEq(tokenIn.balanceOf(operator), 0, "NO fee on failed swap");
        assertEq(tokenIn.balanceOf(user), 1_000e18, "user made whole");
    }

    function test_atomic_noFeeOnSlippageRevert() public {
        vm.prank(user);
        vm.expectRevert(bytes("slippage"));
        fr.swapWithFee(100e18, 500e18, _routes(), block.timestamp + 600, address(0), 0, 0);
        assertEq(tokenIn.balanceOf(operator), 0, "no fee when minOut not met");
    }

    function test_zeroFeeConfigPassesEverything() public {
        fr.setConfig(operator, 0, 3000);
        vm.prank(user);
        uint256 out = fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 0);
        assertEq(tokenIn.balanceOf(operator), 0);
        assertEq(out, 200e18, "full amount swapped");
    }

    function test_ownerControls() public {
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        fr.setConfig(operator, 101, 3000); // >1% rejected

        vm.prank(user);
        vm.expectRevert(FeeRouter.NotOwner.selector);
        fr.setConfig(user, 50, 3000);

        fr.setOwner(user);
        vm.prank(user);
        fr.setConfig(user, 10, 1000);
        assertEq(fr.feeBps(), 10);
    }

    function test_rescue() public {
        tokenIn.mint(address(fr), 5e18); // someone fat-fingers tokens in
        fr.rescue(address(tokenIn), operator, 5e18);
        assertEq(tokenIn.balanceOf(operator), 5e18);
    }

    function test_insufficientBalanceReverts() public {
        vm.prank(user);
        vm.expectRevert();
        fr.swapWithFee(2_000e18, 0, _routes(), block.timestamp + 600, address(0), 0, 0);
    }

    /// Zap path: 2× bps on the swapped half == configured bps on the gross.
    function test_feeBpsOverrideForZapLeg() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 100); // 1% override
        assertEq(tokenIn.balanceOf(operator), 1e18, "override 1% applied instead of default 0.5%");
    }

    function test_feeBpsOverrideAllowsZapDouble() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 200); // 2% on the half-leg
        assertEq(tokenIn.balanceOf(operator), 2e18, "200 bps override for zap half-leg accounting");
    }

    function test_feeBpsOverrideCappedAtMax() public {
        vm.prank(user);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 201); // > override cap rejected
    }

    // ── Audit regressions ────────────────────────────────────────────────────

    /// AUDIT: an override BELOW the configured rate must be rejected — otherwise
    /// any caller sets 1 bps and underpays. amountOutMin cannot catch it (a
    /// smaller fee means MORE output), so the contract must enforce the floor.
    function test_audit_feeBpsOverrideBelowDefaultRejected() public {
        vm.prank(user);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 1);

        vm.prank(user);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 49); // just under feeBps=50
    }

    /// Override exactly AT the configured rate is still allowed (no regression).
    function test_audit_feeBpsOverrideEqualToDefaultAllowed() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 50);
        assertEq(tokenIn.balanceOf(operator), 0.5e18, "50 bps override == default rate");
    }

    /// AUDIT (regression on the fix itself): the fee FLOOR must not make the
    /// advertised referred-trader discount unrepresentable. The bot passes
    /// referredBps (45 when feeBps=50) as the override for a referred swap —
    /// a naive `override >= feeBps` floor reverted EVERY referred swap and
    /// silently killed the referral program.
    function test_audit_referredDiscountStillWorksUnderFeeFloor() public {
        assertEq(fr.referredFeeBps(), 45, "default discount = 90% of 50 bps");
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, referrer, 3000, 45);
        // fee = 0.45 (45 bps); referrer 30% = 0.135; operator 0.315
        assertEq(tokenIn.balanceOf(referrer), 0.135e18, "referrer paid at the discounted rate");
        assertEq(tokenIn.balanceOf(operator), 0.315e18, "operator keeps the rest");
    }

    /// The discounted floor applies ONLY with a genuine referrer — a caller with
    /// no referrer still cannot underpay.
    function test_audit_discountFloorNotAvailableWithoutReferrer() public {
        vm.prank(user);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 45);
    }

    /// AUDIT: naming YOURSELF as referrer must not rebate any of your own fee.
    function test_audit_selfReferralPaysNoRebate() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, user, 3000, 0);
        assertEq(tokenIn.balanceOf(operator), 0.5e18, "operator keeps the WHOLE fee");
        // user's only tokenIn movement is the 100e18 they swapped — no rebate back.
        assertEq(tokenIn.balanceOf(user), 900e18, "no self-rebate");
    }

    // ── Re-audit regressions ─────────────────────────────────────────────────

    /// AUDIT: naming an UNREGISTERED address must not unlock the discount.
    /// Previously any caller passed referrer=0xdEaD, referralShareBps=0 and paid
    /// the discounted floor with no referral occurring at all.
    function test_audit_unattestedReferrerGetsNoDiscount() public {
        vm.prank(user);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0xdEaD), 0, 45);

        // ...and with no override it is charged the FULL headline rate.
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0xdEaD), 3000, 0);
        assertEq(tokenIn.balanceOf(operator), 0.5e18, "full 50 bps, no discount");
        assertEq(tokenIn.balanceOf(address(0xdEaD)), 0, "unattested referrer paid nothing");
    }

    /// AUDIT: setConfig must RE-DERIVE the discount, not clamp one-way. A promo
    /// (100 -> 40) then restore (-> 100) used to latch the floor at 40 forever.
    function test_audit_setConfigReDerivesDiscount() public {
        fr.setConfig(operator, 40, 3000);
        assertEq(fr.referredFeeBps(), 36, "re-derived to 90% of 40");
        fr.setConfig(operator, 100, 3000);
        assertEq(fr.referredFeeBps(), 90, "restored to 90% of 100, not latched at 36");
    }

    /// AUDIT: the discount is the charged RATE for an attested referral, so a
    /// referred trader who passes no override still pays the reduced rate.
    function test_audit_discountIsRateNotOnlyFloor() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, referrer, 3000, 0);
        assertEq(tokenIn.balanceOf(operator) + tokenIn.balanceOf(referrer), 0.45e18, "45 bps total, not 50");
    }

    /// Rebinding a trader to a different referrer removes the old one's payout.
    function test_audit_rebindingRemovesTheOldReferrersPayout() public {
        address[] memory refs = new address[](1);
        refs[0] = user;
        fr.bindReferrers(refs, address(0xB0B)); // bound to someone else now
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, referrer, 3000, 0);
        assertEq(tokenIn.balanceOf(operator), 0.5e18, "full rate: the named referrer is not the bound one");
        assertEq(tokenIn.balanceOf(referrer), 0, "unbound referrer is paid nothing");
    }

    /// AUDIT: the fee is bps of a CALLER-CHOSEN token, so an attacker could mint
    /// a worthless token, make it hop 0, and have the real trade settle later -
    /// paying the operator in dust while every rate check passed.
    function test_audit_feeCannotBeDenominatedInAnUnapprovedToken() public {
        MockERC20 junk = new MockERC20();
        junk.mint(user, 1_000_000e18);
        vm.prank(user);
        junk.approve(address(fr), type(uint256).max);

        Route[] memory r = new Route[](1);
        r[0] = Route({from: address(junk), to: address(tokenOut), stable: false, factory: address(0xFAC)});
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.FeeTokenNotAllowed.selector, address(junk)));
        fr.swapWithFee(1_000_000e18, 0, r, block.timestamp + 600, address(0), 0, 0);
    }

    /// AUDIT: a global "is a referrer" flag let ANY caller name a stranger's
    /// attested address to take the discount + rebate. The binding is per-trader.
    function test_audit_unboundTraderCannotClaimSomeoneElsesReferrer() public {
        address freeloader = address(0xF4EE);
        tokenIn.mint(freeloader, 100e18);
        vm.prank(freeloader);
        tokenIn.approve(address(fr), type(uint256).max);

        vm.prank(freeloader);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, referrer, 3000, 0);

        // Full rate to the operator, nothing diverted: the relationship was never bound.
        assertEq(tokenIn.balanceOf(referrer), 0, "unbound referrer must be paid 0");
        assertEq(tokenIn.balanceOf(operator), 0.5e18, "operator must get the FULL 50 bps, not the 45 bps referred rate");
    }

    /// AUDIT: swapWithFee cannot tell a zap leg from a plain swap, so its floor
    /// was the single rate - anyone could route a zap through it and pay half
    /// the intended fee. zapLegWithFee enforces the doubled floor.
    function test_audit_zapLegCannotBeUnderpaidViaPlainSwapFloor() public {
        // 50 bps clears swapWithFee's floor but is HALF a zap leg's correct rate.
        vm.prank(user);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        fr.zapLegWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 50);

        // The correct doubled rate is accepted, and charged.
        vm.prank(user);
        fr.zapLegWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, 100);
        assertEq(tokenIn.balanceOf(operator), 1e18, "zap leg must pay 2x the plain-swap rate");
    }

    /// AUDIT: a codeless address makes every low-level token call return
    /// ok=true with empty returndata, so a swap could "succeed" moving nothing.
    function test_audit_codelessTokenRejected() public {
        address ghost = address(0x6057);
        address[] memory fts = new address[](1);
        fts[0] = ghost;
        fr.setFeeTokens(fts, true); // even explicitly allowed, it has no code

        Route[] memory r = new Route[](1);
        r[0] = Route({from: ghost, to: address(tokenOut), stable: false, factory: address(0xFAC)});
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NotAContract.selector, ghost));
        fr.swapWithFee(1e18, 0, r, block.timestamp + 600, address(0), 0, 0);
    }

    /// AUDIT: setConfig used to re-derive referredFeeBps unconditionally,
    /// silently discarding a deliberately-set promo rate on an unrelated change.
    function test_audit_setConfigKeepsAnExplicitlyPinnedReferredRate() public {
        fr.setReferredFeeBps(20);
        fr.setConfig(operator, 50, 3000); // rotate recipient, unrelated to the promo
        assertEq(fr.referredFeeBps(), 20, "pinned promo rate must survive setConfig");
    }
}

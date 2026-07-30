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
        uint256 out = fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0);
        // fee = 0.5% of 100 = 0.5; net = 99.5 swapped at 2x
        assertEq(tokenIn.balanceOf(operator), 0.5e18, "operator fee");
        assertEq(out, 199e18, "amountOut");
        assertEq(tokenOut.balanceOf(user), 199e18, "user got output DIRECTLY");
        assertEq(tokenIn.balanceOf(address(fr)), 0, "escrowless: nothing retained");
    }

    function test_referralSplitAtSource() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, referrer, 3000);
        assertEq(tokenIn.balanceOf(referrer), 0.15e18, "referrer 30% of fee");
        assertEq(tokenIn.balanceOf(operator), 0.35e18, "operator 70% of fee");
    }

    function test_referralShareClampedToMax() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, referrer, 9000); // asks 90%
        assertEq(tokenIn.balanceOf(referrer), 0.15e18, "clamped to 30% max");
    }

    /// THE property this contract exists for: swap fails => fee reverts too.
    function test_atomic_noFeeOnFailedSwap() public {
        router.setRevert(true);
        vm.prank(user);
        vm.expectRevert(bytes("router: revert"));
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0);
        assertEq(tokenIn.balanceOf(operator), 0, "NO fee on failed swap");
        assertEq(tokenIn.balanceOf(user), 1_000e18, "user made whole");
    }

    function test_atomic_noFeeOnSlippageRevert() public {
        vm.prank(user);
        vm.expectRevert(bytes("slippage"));
        fr.swapWithFee(100e18, 500e18, _routes(), block.timestamp + 600, address(0), 0);
        assertEq(tokenIn.balanceOf(operator), 0, "no fee when minOut not met");
    }

    function test_zeroFeeConfigPassesEverything() public {
        fr.setConfig(operator, 0, 3000);
        vm.prank(user);
        uint256 out = fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0);
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
        fr.swapWithFee(2_000e18, 0, _routes(), block.timestamp + 600, address(0), 0);
    }
}

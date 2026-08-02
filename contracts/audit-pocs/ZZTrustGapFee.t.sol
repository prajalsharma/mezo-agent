// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import {FeeRouter, Route} from "../src/FeeRouter.sol";

contract MockERC20b {
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

contract MockRouterB {
    MockERC20b public immutable tokenOut;
    constructor(MockERC20b o) { tokenOut = o; }
    function swapExactTokensForTokens(uint256 amountIn, uint256 min, Route[] calldata r, address to, uint256)
        external returns (uint256[] memory a)
    {
        MockERC20b(r[0].from).transferFrom(msg.sender, address(this), amountIn);
        uint256 out = amountIn * 2;
        require(out >= min, "slippage");
        tokenOut.mint(to, out);
        a = new uint256[](2); a[0] = amountIn; a[1] = out;
    }
}

contract ZZTrustGapFee is Test {
    MockERC20b tin;
    MockERC20b tout;
    MockRouterB router;
    FeeRouter fr;

    address user = address(0xBEEF);
    address userAlt = address(0xA17); // a SECOND address the same trader controls
    address operator = address(0xFEE);

    uint16 constant SWAP_BPS = 50; // AGENT_FEE_BPS, deployed as feeBps
    uint16 constant REFERRED_BPS = 45; // constructor: feeBps * 90 / 100

    function setUp() public {
        tin = new MockERC20b();
        tout = new MockERC20b();
        router = new MockRouterB(tout);
        fr = new FeeRouter(address(router), operator, SWAP_BPS, 3000);
        tin.mint(user, 1_000e18);
        vm.prank(user);
        tin.approve(address(fr), type(uint256).max);
        assertEq(fr.referredFeeBps(), REFERRED_BPS);
    }

    function _routes() internal view returns (Route[] memory r) {
        r = new Route[](1);
        r[0] = Route({from: address(tin), to: address(tout), stable: false, factory: address(0xFAC)});
    }

    /// Baseline: an honest trader pays the full 50 bps; the operator keeps it all.
    function test_baseline_honestTraderPaysFull() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, SWAP_BPS);
        assertEq(tin.balanceOf(operator), 0.5e18, "operator keeps 50 bps");
    }

    /// Naming YOURSELF is correctly rejected as a rebate...
    function test_selfReferralStillBlocked() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, user, 3000, SWAP_BPS);
        assertEq(tin.balanceOf(operator), 0.5e18, "no self-rebate");
        assertEq(tin.balanceOf(user), 900e18, "nothing came back");
    }

    /// ...but a SECOND address the same trader controls defeats it completely,
    /// and simultaneously unlocks the lower referred FLOOR.
    function test_altAddressReferrerUnlocksFloorAndRebate() public {
        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, userAlt, 10_000, REFERRED_BPS);

        // 1. The floor dropped from 50 to 45 just by naming a referrer.
        // 2. 30% of that fee was paid straight back to the trader's own address.
        assertEq(tin.balanceOf(userAlt), 0.135e18, "30% of the 45 bps fee rebated to the trader");
        assertEq(tin.balanceOf(operator), 0.315e18, "operator keeps only 31.5 bps");

        // Operator revenue vs the honest baseline of 0.5e18: -37%.
        uint256 baseline = 0.5e18;
        uint256 got = tin.balanceOf(operator);
        assertEq(((baseline - got) * 100) / baseline, uint256(37), "37% revenue loss");
    }

    /// The floor is evaluated against MUTABLE owner state, so an owner fee raise
    /// retroactively bricks calldata a user already signed at the old rate.
    function test_ownerFeeRaiseBricksInFlightCalldata() public {
        fr.setConfig(operator, 100, 3000); // deployer is owner
        vm.prank(user);
        vm.expectRevert(FeeRouter.FeeTooHigh.selector);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, address(0), 0, SWAP_BPS);
    }
}

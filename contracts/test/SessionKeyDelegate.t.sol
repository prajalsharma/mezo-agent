// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {SessionKeyDelegate} from "../src/SessionKeyDelegate.sol";

/// @dev A trivial target that records the last native value it received.
contract Target {
    uint256 public lastValue;
    address public lastCaller;

    function ping() external payable {
        lastValue = msg.value;
        lastCaller = msg.sender;
    }
}

/**
 * @dev Under EIP-7702 the delegate runs in the root EOA's context, so a
 *      root-initiated call has `msg.sender == address(this)`. We reproduce that
 *      "self" condition with `vm.prank(address(delegate))`; a session key is
 *      just an ordinary address that calls `execute` directly.
 */
contract SessionKeyDelegateTest is Test {
    SessionKeyDelegate internal delegate;
    Target internal target;

    address internal sessionKey = address(0x5E5510);
    address internal stranger = address(0xBAD);

    uint48 internal expiry;
    uint128 internal constant PER_TX = 1 ether;
    uint128 internal constant DAILY = 2 ether;

    function setUp() public {
        delegate = new SessionKeyDelegate();
        target = new Target();
        expiry = uint48(block.timestamp + 30 days);
        vm.deal(address(delegate), 100 ether);
    }

    function _register(address key, address[] memory targets) internal {
        vm.prank(address(delegate)); // simulate the root acting on itself
        delegate.registerSession(key, expiry, PER_TX, DAILY, targets);
    }

    function _targets() internal view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(target);
    }

    // ─── Management is root-only ───────────────────────────────────────────────

    function test_registerSession_onlySelf() public {
        vm.prank(stranger);
        vm.expectRevert(SessionKeyDelegate.NotRoot.selector);
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, _targets());
    }

    function test_revokeSession_onlySelf() public {
        _register(sessionKey, _targets());
        vm.prank(stranger);
        vm.expectRevert(SessionKeyDelegate.NotRoot.selector);
        delegate.revokeSession(sessionKey);
    }

    // ─── Happy path ────────────────────────────────────────────────────────────

    function test_sessionExecuteWithinCaps() public {
        _register(sessionKey, _targets());
        vm.prank(sessionKey);
        delegate.execute(address(target), 0.5 ether, abi.encodeCall(Target.ping, ()));
        assertEq(target.lastValue(), 0.5 ether);
        assertEq(target.lastCaller(), address(delegate)); // call originates from the account

        (,,,,, uint128 spentToday) = delegate.getSession(sessionKey);
        assertEq(spentToday, 0.5 ether);
    }

    function test_rootCanExecuteWithoutCaps() public {
        // No session registered; the account itself bypasses caps entirely.
        vm.prank(address(delegate));
        delegate.execute(address(target), 10 ether, abi.encodeCall(Target.ping, ()));
        assertEq(target.lastValue(), 10 ether);
    }

    // ─── On-chain limit enforcement ────────────────────────────────────────────

    function test_perTxCapExceeded() public {
        _register(sessionKey, _targets());
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.PerTxCapExceeded.selector, 1.5 ether, PER_TX)
        );
        delegate.execute(address(target), 1.5 ether, abi.encodeCall(Target.ping, ()));
    }

    function test_dailyCapExceeded() public {
        _register(sessionKey, _targets());
        // Two 1 ETH ops are fine (== 2 ETH daily cap); the third exceeds it.
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, abi.encodeCall(Target.ping, ()));
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, abi.encodeCall(Target.ping, ()));
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.DailyCapExceeded.selector, 3 ether, DAILY)
        );
        delegate.execute(address(target), 1 ether, abi.encodeCall(Target.ping, ()));
    }

    function test_dailyCapResetsAfterWindow() public {
        _register(sessionKey, _targets());
        // Spend up to the daily cap (2 x 1 ETH, each within the 1 ETH per-tx cap).
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, abi.encodeCall(Target.ping, ()));
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, abi.encodeCall(Target.ping, ()));
        // Move past the 24h window; the counter resets and spending is allowed again.
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, abi.encodeCall(Target.ping, ()));
        (,,,,, uint128 spentToday) = delegate.getSession(sessionKey);
        assertEq(spentToday, 1 ether);
    }

    function test_targetNotAllowed() public {
        _register(sessionKey, _targets());
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.TargetNotAllowed.selector, address(0xC0FFEE))
        );
        delegate.execute(address(0xC0FFEE), 0, "");
    }

    function test_expiredSession() public {
        _register(sessionKey, _targets());
        vm.warp(uint256(expiry) + 1);
        vm.prank(sessionKey);
        vm.expectRevert(SessionKeyDelegate.SessionExpired.selector);
        delegate.execute(address(target), 0.1 ether, abi.encodeCall(Target.ping, ()));
    }

    function test_unknownSession() public {
        vm.prank(stranger);
        vm.expectRevert(SessionKeyDelegate.UnknownSession.selector);
        delegate.execute(address(target), 0, "");
    }

    function test_revokeStopsExecution() public {
        _register(sessionKey, _targets());
        vm.prank(address(delegate));
        delegate.revokeSession(sessionKey);
        vm.prank(sessionKey);
        vm.expectRevert(SessionKeyDelegate.UnknownSession.selector);
        delegate.execute(address(target), 0.1 ether, abi.encodeCall(Target.ping, ()));
    }

    // ─── Audit regression: F1 self-call confused-deputy escalation ─────────────

    function test_cannotRegisterSelfAsTarget() public {
        // Allowlisting the account's own address for a session is forbidden — this
        // is the precondition for the self-call escalation, so it can't be created.
        address[] memory t = new address[](1);
        t[0] = address(delegate);
        vm.prank(address(delegate));
        vm.expectRevert(SessionKeyDelegate.SelfTargetForbidden.selector);
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, t);
    }

    function test_sessionCannotCallDelegateItself() public {
        _register(sessionKey, _targets());
        // Even attempting to route a call back into the delegate is rejected
        // before any allowlist/cap check — closing the onlySelf bypass.
        vm.prank(sessionKey);
        vm.expectRevert(SessionKeyDelegate.SelfTargetForbidden.selector);
        delegate.execute(
            address(delegate),
            0,
            abi.encodeCall(
                SessionKeyDelegate.registerSession,
                (sessionKey, type(uint48).max, type(uint128).max, type(uint128).max, new address[](0))
            )
        );
    }

    function test_setTargetRejectsSelfAndRequiresSession() public {
        vm.prank(address(delegate));
        vm.expectRevert(SessionKeyDelegate.UnknownSession.selector);
        delegate.setTarget(sessionKey, address(target), true); // no session yet

        _register(sessionKey, _targets());
        vm.prank(address(delegate));
        vm.expectRevert(SessionKeyDelegate.SelfTargetForbidden.selector);
        delegate.setTarget(sessionKey, address(delegate), true);
    }

    // ─── Audit regression: F2 scope is replaced, not unioned ───────────────────

    function test_reRegisterReplacesTargets() public {
        Target other = new Target();
        _register(sessionKey, _targets()); // allow `target`
        assertTrue(delegate.isAllowed(sessionKey, address(target)));

        address[] memory t2 = new address[](1);
        t2[0] = address(other);
        vm.prank(address(delegate));
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, t2); // now only `other`

        assertFalse(delegate.isAllowed(sessionKey, address(target)), "old target must be cleared");
        assertTrue(delegate.isAllowed(sessionKey, address(other)));
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.TargetNotAllowed.selector, address(target))
        );
        delegate.execute(address(target), 0, abi.encodeCall(Target.ping, ()));
    }

    function test_revokeClearsAllowlistAcrossReuse() public {
        _register(sessionKey, _targets());
        vm.prank(address(delegate));
        delegate.revokeSession(sessionKey);
        // Reusing the same key address with a different scope must not inherit
        // the old allowlist entry.
        Target other = new Target();
        address[] memory t2 = new address[](1);
        t2[0] = address(other);
        vm.prank(address(delegate));
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, t2);
        assertFalse(delegate.isAllowed(sessionKey, address(target)), "stale target survived revoke");
    }
}

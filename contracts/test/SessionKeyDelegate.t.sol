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

/// @dev Minimal ERC-20 used to prove decoded-amount caps actually bite.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address holder, uint256 amount) {
        balanceOf[holder] = amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
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
    MockToken internal token;

    address internal sessionKey = address(0x5E5510);
    address internal stranger = address(0xBAD);
    address internal spender = address(0x5DE4DE);

    uint48 internal expiry;
    uint128 internal constant PER_TX = 1 ether;
    uint128 internal constant DAILY = 2 ether;
    uint128 internal constant TOK_PER_TX = 100e18;
    uint128 internal constant TOK_DAILY = 150e18;

    bytes4 internal constant SEL_PING = Target.ping.selector;
    bytes4 internal constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 internal constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));

    function setUp() public {
        delegate = new SessionKeyDelegate();
        target = new Target();
        token = new MockToken(address(delegate), 1_000e18);
        expiry = uint48(block.timestamp + 30 days);
        vm.deal(address(delegate), 100 ether);
    }

    /// @dev Default scope: `target` callable via ping(), no token caps.
    function _policies() internal view returns (SessionKeyDelegate.TargetPolicy[] memory p) {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = SEL_PING;
        p = new SessionKeyDelegate.TargetPolicy[](1);
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(target),
            selectors: sels,
            tokenPerTxCap: 0,
            tokenDailyCap: 0,
            allowUndecodedSelectors: true
        });
    }

    function _register(address key, SessionKeyDelegate.TargetPolicy[] memory p) internal {
        vm.prank(address(delegate)); // simulate the root acting on itself
        delegate.registerSession(key, expiry, PER_TX, DAILY, p);
    }

    function _ping() internal pure returns (bytes memory) {
        return abi.encodeCall(Target.ping, ());
    }

    // ─── Management is root-only ───────────────────────────────────────────────

    function test_registerSession_onlySelf() public {
        vm.prank(stranger);
        vm.expectRevert(SessionKeyDelegate.NotRoot.selector);
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, _policies());
    }

    function test_revokeSession_onlySelf() public {
        _register(sessionKey, _policies());
        vm.prank(stranger);
        vm.expectRevert(SessionKeyDelegate.NotRoot.selector);
        delegate.revokeSession(sessionKey);
    }

    // ─── Happy path ────────────────────────────────────────────────────────────

    function test_sessionExecuteWithinCaps() public {
        _register(sessionKey, _policies());
        vm.prank(sessionKey);
        delegate.execute(address(target), 0.5 ether, _ping());
        assertEq(target.lastValue(), 0.5 ether);
        assertEq(target.lastCaller(), address(delegate));
        assertEq(delegate.nativeUsage(sessionKey), 0.5 ether);
    }

    function test_rootCanExecuteWithoutCaps() public {
        vm.prank(address(delegate));
        delegate.execute(address(target), 10 ether, _ping());
        assertEq(target.lastValue(), 10 ether);
    }

    // ─── Native limit enforcement ──────────────────────────────────────────────

    function test_perTxCapExceeded() public {
        _register(sessionKey, _policies());
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.PerTxCapExceeded.selector, 1.5 ether, PER_TX)
        );
        delegate.execute(address(target), 1.5 ether, _ping());
    }

    function test_dailyCapExceeded() public {
        _register(sessionKey, _policies());
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, _ping());
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, _ping());
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.DailyCapExceeded.selector, 3 ether, DAILY)
        );
        delegate.execute(address(target), 1 ether, _ping());
    }

    function test_targetNotAllowed() public {
        _register(sessionKey, _policies());
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.TargetNotAllowed.selector, address(0xC0FFEE))
        );
        delegate.execute(address(0xC0FFEE), 0, "");
    }

    function test_expiredSession() public {
        _register(sessionKey, _policies());
        vm.warp(uint256(expiry) + 1);
        vm.prank(sessionKey);
        vm.expectRevert(SessionKeyDelegate.SessionExpired.selector);
        delegate.execute(address(target), 0.1 ether, _ping());
    }

    function test_unknownSession() public {
        vm.prank(stranger);
        vm.expectRevert(SessionKeyDelegate.UnknownSession.selector);
        delegate.execute(address(target), 0, "");
    }

    function test_revokeStopsExecution() public {
        _register(sessionKey, _policies());
        vm.prank(address(delegate));
        delegate.revokeSession(sessionKey);
        vm.prank(sessionKey);
        vm.expectRevert(SessionKeyDelegate.UnknownSession.selector);
        delegate.execute(address(target), 0.1 ether, _ping());
    }

    // ─── F1 regression: self-call confused-deputy escalation ───────────────────

    function test_cannotRegisterSelfAsTarget() public {
        bytes4[] memory sels = new bytes4[](0);
        SessionKeyDelegate.TargetPolicy[] memory p = new SessionKeyDelegate.TargetPolicy[](1);
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(delegate), selectors: sels, tokenPerTxCap: 0, tokenDailyCap: 0,
            allowUndecodedSelectors: true
        });
        vm.prank(address(delegate));
        vm.expectRevert(SessionKeyDelegate.SelfTargetForbidden.selector);
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, p);
    }

    function test_sessionCannotCallDelegateItself() public {
        _register(sessionKey, _policies());
        vm.prank(sessionKey);
        vm.expectRevert(SessionKeyDelegate.SelfTargetForbidden.selector);
        delegate.execute(address(delegate), 0, abi.encodeCall(SessionKeyDelegate.revokeSession, (sessionKey)));
    }

    // ─── F2 regression: scope is replaced, not unioned ─────────────────────────

    function test_reRegisterReplacesScope() public {
        _register(sessionKey, _policies());
        assertTrue(delegate.isAllowed(sessionKey, address(target)));

        Target other = new Target();
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = SEL_PING;
        SessionKeyDelegate.TargetPolicy[] memory p2 = new SessionKeyDelegate.TargetPolicy[](1);
        p2[0] = SessionKeyDelegate.TargetPolicy({
            target: address(other), selectors: sels, tokenPerTxCap: 0, tokenDailyCap: 0,
            allowUndecodedSelectors: true
        });
        vm.prank(address(delegate));
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, p2);

        assertFalse(delegate.isAllowed(sessionKey, address(target)), "old target must be cleared");
        assertFalse(delegate.isSelectorAllowed(sessionKey, address(target), SEL_PING), "old selector must be cleared");
        assertTrue(delegate.isAllowed(sessionKey, address(other)));
    }

    function test_revokeClearsScopeAcrossReuse() public {
        _register(sessionKey, _policies());
        vm.prank(address(delegate));
        delegate.revokeSession(sessionKey);
        assertFalse(delegate.isAllowed(sessionKey, address(target)), "stale target survived revoke");
        assertFalse(delegate.isSelectorAllowed(sessionKey, address(target), SEL_PING));
    }

    // ─── F3 regression: calldata is capped, not a blank cheque ─────────────────

    function _tokenPolicies() internal view returns (SessionKeyDelegate.TargetPolicy[] memory p) {
        bytes4[] memory tokSels = new bytes4[](2);
        tokSels[0] = SEL_TRANSFER;
        tokSels[1] = SEL_APPROVE;
        bytes4[] memory noSels = new bytes4[](0);
        p = new SessionKeyDelegate.TargetPolicy[](2);
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(token), selectors: tokSels, tokenPerTxCap: TOK_PER_TX, tokenDailyCap: TOK_DAILY,
            allowUndecodedSelectors: true
        });
        // `spender` is allowlisted purely so it is a legal approve/transfer counterparty.
        p[1] = SessionKeyDelegate.TargetPolicy({
            target: spender, selectors: noSels, tokenPerTxCap: 0, tokenDailyCap: 0,
            allowUndecodedSelectors: true
        });
    }

    function test_unlistedSelectorRejected() public {
        _register(sessionKey, _policies()); // only ping() allowed on `target`
        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SelectorNotAllowed.selector, SEL_TRANSFER));
        delegate.execute(address(target), 0, abi.encodeWithSelector(SEL_TRANSFER, stranger, 1e18));
    }

    function test_erc20TransferCappedByDecodedAmount() public {
        _register(sessionKey, _tokenPolicies());
        // Within the per-tx token cap: succeeds.
        vm.prank(sessionKey);
        delegate.execute(address(token), 0, abi.encodeWithSelector(SEL_TRANSFER, spender, 60e18));
        assertEq(token.balanceOf(spender), 60e18);

        // Over the per-tx token cap: rejected even though native value is 0.
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.TokenPerTxCapExceeded.selector, 500e18, TOK_PER_TX)
        );
        delegate.execute(address(token), 0, abi.encodeWithSelector(SEL_TRANSFER, spender, 500e18));
    }

    function test_erc20DailyTokenCap() public {
        _register(sessionKey, _tokenPolicies());
        vm.prank(sessionKey);
        delegate.execute(address(token), 0, abi.encodeWithSelector(SEL_TRANSFER, spender, 100e18));
        // 100 + 100 = 200 > 150 daily token cap.
        vm.prank(sessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(SessionKeyDelegate.TokenDailyCapExceeded.selector, 200e18, TOK_DAILY)
        );
        delegate.execute(address(token), 0, abi.encodeWithSelector(SEL_TRANSFER, spender, 100e18));
    }

    function test_cannotApproveArbitrarySpender() public {
        _register(sessionKey, _tokenPolicies());
        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SpenderNotAllowed.selector, stranger));
        delegate.execute(address(token), 0, abi.encodeWithSelector(SEL_APPROVE, stranger, 1e18));
    }

    // ─── F4 regression: true sliding window, no boundary double-spend ──────────

    function test_slidingWindowBlocksBoundaryDoubleSpend() public {
        _register(sessionKey, _policies());
        // Land at the very end of a window and spend the full daily cap.
        uint256 windowEnd = (block.timestamp / 1 days + 1) * 1 days;
        vm.warp(windowEnd - 1);
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, _ping());
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, _ping());

        // Cross the boundary: under the OLD fixed window this reset to zero and
        // allowed another full cap (2x burst). The sliding window still counts it.
        vm.warp(windowEnd + 1);
        vm.prank(sessionKey);
        vm.expectRevert();
        delegate.execute(address(target), 1 ether, _ping());
    }

    // ─── Re-audit regressions (round 2) ───────────────────────────────────────

    /// N3: the exact 3-spend trace that defeated the old weighted window.
    function test_noDoubleSpendWithinTrueTrailing24h() public {
        _register(sessionKey, _policies());
        uint256 day = 1 days;
        uint256 base = (block.timestamp / day) * day;
        // Spend the full daily cap at the very end of a day bucket.
        vm.warp(base + day - 1);
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, _ping());
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, _ping());
        // ~12h later (well inside a true trailing 24h) any further spend must fail.
        vm.warp(base + day + day / 2);
        vm.prank(sessionKey);
        vm.expectRevert();
        delegate.execute(address(target), 1 ether, _ping());
        // And just under 24h after the first spend it must STILL fail.
        vm.warp(base + 2 * day - 3);
        vm.prank(sessionKey);
        vm.expectRevert();
        delegate.execute(address(target), 1 ether, _ping());
    }

    /// N1: transferFrom may only move the account's own tokens.
    function test_transferFromForeignSourceRejected() public {
        _register(sessionKey, _tokenPolicies());
        bytes4 selTransferFrom = bytes4(keccak256("transferFrom(address,address,uint256)"));
        // Grant the selector so we reach the source check specifically.
        bytes4[] memory sels = new bytes4[](3);
        sels[0] = SEL_TRANSFER; sels[1] = SEL_APPROVE; sels[2] = selTransferFrom;
        SessionKeyDelegate.TargetPolicy memory p = SessionKeyDelegate.TargetPolicy({
            target: address(token), selectors: sels, tokenPerTxCap: TOK_PER_TX, tokenDailyCap: TOK_DAILY,
            allowUndecodedSelectors: true
        });
        vm.prank(address(delegate));
        delegate.setTargetPolicy(sessionKey, p);

        address victim = address(0xC1C71);
        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.ForeignSourceForbidden.selector, victim));
        delegate.execute(address(token), 0, abi.encodeWithSelector(selTransferFrom, victim, spender, 1e18));
    }

    /// N2: policy churn must not grow the target array (revocation stays cheap).
    function test_targetArrayDoesNotGrowOnPolicyChurn() public {
        _register(sessionKey, _policies());
        assertEq(delegate.targetCount(sessionKey), 1);
        for (uint256 i = 0; i < 10; i++) {
            bytes4[] memory sels = new bytes4[](1);
            sels[0] = SEL_PING;
            SessionKeyDelegate.TargetPolicy memory p = SessionKeyDelegate.TargetPolicy({
                target: address(target), selectors: sels, tokenPerTxCap: 0, tokenDailyCap: 0,
            allowUndecodedSelectors: true
            });
            vm.prank(address(delegate));
            delegate.setTargetPolicy(sessionKey, p);
        }
        assertEq(delegate.targetCount(sessionKey), 1, "duplicates leaked into _keyTargets");

        vm.prank(address(delegate));
        delegate.removeTarget(sessionKey, address(target));
        assertEq(delegate.targetCount(sessionKey), 0);
        assertFalse(delegate.isAllowed(sessionKey, address(target)));
    }

    /// Lead: the token contract itself is not a valid counterparty.
    function test_cannotSendTokensToTokenItself() public {
        _register(sessionKey, _tokenPolicies());
        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SpenderNotAllowed.selector, address(token)));
        delegate.execute(address(token), 0, abi.encodeWithSelector(SEL_TRANSFER, address(token), 1e18));
    }

    /// Lead: a token target cannot be granted an un-decoded (uncapped) selector.
    function test_tokenTargetRejectsUncappedSelector() public {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = SEL_PING; // not one of transfer/approve/transferFrom
        SessionKeyDelegate.TargetPolicy[] memory p = new SessionKeyDelegate.TargetPolicy[](1);
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(token), selectors: sels, tokenPerTxCap: TOK_PER_TX, tokenDailyCap: TOK_DAILY,
            allowUndecodedSelectors: true
        });
        vm.prank(address(delegate));
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.UncappedSelectorOnToken.selector, SEL_PING));
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, p);
    }

    function test_slidingWindowFreesUpAfterFullPeriod() public {
        _register(sessionKey, _policies());
        uint256 start = (block.timestamp / 1 days) * 1 days + 100;
        vm.warp(start);
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, _ping());
        // A full period later the earlier spend has aged out entirely.
        vm.warp(start + 2 days);
        vm.prank(sessionKey);
        delegate.execute(address(target), 1 ether, _ping());
        assertEq(delegate.nativeUsage(sessionKey), 1 ether);
    }

    /// AUDIT: naming the same target twice in one registerSession would UNION
    /// selectors while `isTokenTarget` is evaluated per entry — entry 1 (zero
    /// caps) slips an un-decoded selector past the guard, entry 2 then adds the
    /// caps, leaving an uncapped value-moving selector on a capped token.
    /// Duplicate targets must be rejected outright.
    function test_audit_duplicateTargetInRegisterSessionRejected() public {
        bytes4[] memory uncapped = new bytes4[](1);
        uncapped[0] = SEL_PING; // un-decoded, hence uncapped
        bytes4[] memory decoded = new bytes4[](1);
        decoded[0] = SEL_TRANSFER;

        SessionKeyDelegate.TargetPolicy[] memory p = new SessionKeyDelegate.TargetPolicy[](2);
        // Entry 1: zero caps => isTokenTarget false => guard short-circuits.
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(token), selectors: uncapped, tokenPerTxCap: 0, tokenDailyCap: 0,
            allowUndecodedSelectors: true
        });
        // Entry 2: same target, now WITH caps.
        p[1] = SessionKeyDelegate.TargetPolicy({
            target: address(token), selectors: decoded, tokenPerTxCap: TOK_PER_TX, tokenDailyCap: TOK_DAILY,
            allowUndecodedSelectors: true
        });

        vm.prank(address(delegate));
        vm.expectRevert(SessionKeyDelegate.DuplicateTarget.selector);
        delegate.registerSession(sessionKey, expiry, PER_TX, DAILY, p);
    }

    /// AUDIT (4 agents): an undecoded selector used to hit `else { return; }`,
    /// which was a free pass - the target allowlist gates who is CALLED, never
    /// who gets PAID. Default is now DENY unless explicitly opted in.
    function test_audit_undecodedSelectorDeniedByDefault() public {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = SEL_PING;
        SessionKeyDelegate.TargetPolicy[] memory p = new SessionKeyDelegate.TargetPolicy[](1);
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(target),
            selectors: sels,
            tokenPerTxCap: 0,
            tokenDailyCap: 0,
            allowUndecodedSelectors: false // the new default
        });
        _register(sessionKey, p);

        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.UndecodableSelector.selector, SEL_PING));
        delegate.execute(address(target), 0.1 ether, _ping());
    }

    /// AUDIT: the escape hatch must never apply to a target that can move ERC-20s,
    /// whatever the caller passed.
    function test_audit_escapeHatchIgnoredOnTokenTargets() public {
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = SEL_TRANSFER;
        SessionKeyDelegate.TargetPolicy[] memory p = new SessionKeyDelegate.TargetPolicy[](1);
        p[0] = SessionKeyDelegate.TargetPolicy({
            target: address(token),
            selectors: sels,
            tokenPerTxCap: TOK_PER_TX,
            tokenDailyCap: TOK_DAILY,
            allowUndecodedSelectors: true // asked for, must be ignored
        });
        _register(sessionKey, p);
        // transfer IS decoded, so the recipient guard still fires as before.
        vm.prank(sessionKey);
        vm.expectRevert(abi.encodeWithSelector(SessionKeyDelegate.SpenderNotAllowed.selector, address(0xBAD)));
        delegate.execute(address(token), 0, abi.encodeWithSelector(SEL_TRANSFER, address(0xBAD), 0.1 ether));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title SessionKeyDelegate
 * @notice Minimal EIP-7702 delegate for the Mezo agent (Phase-1, "Option A":
 *         semi-custodial). An account's root EOA installs this contract as its
 *         delegation designator (`0xef0100 || SessionKeyDelegate`) via a
 *         type-0x04 authorization. Once installed, the contract runs in the
 *         EOA's own storage/balance context and lets the root grant narrowly
 *         scoped, revocable "session keys" that can execute calls on the
 *         account's behalf WITHIN on-chain limits.
 *
 * @dev Trust model
 *      - The ROOT (the account itself) is the only manager. Every management
 *        function is guarded by `onlySelf` (`msg.sender == address(this)`),
 *        which under EIP-7702 self-execution means the tx was signed by the
 *        account's own key. Session keys can NEVER register or revoke sessions.
 *      - A SESSION KEY is an ordinary EOA whose address is registered here. It
 *        authorizes an op simply by being the `msg.sender` of the call to
 *        `execute` — i.e. the transaction's own ECDSA signature is the
 *        authorization, so this contract needs no in-contract signature
 *        verification and no 4337 machinery.
 *      - Limits are enforced HERE, on-chain, independent of any off-chain app
 *        check. A compromised session key can spend at most its per-tx cap, at
 *        most its rolling-daily cap, only to allowlisted targets, and only
 *        before it expires.
 *
 *      Scope of caps: native value (BTC on Mezo) only, matching the Phase-1
 *      off-chain policy. Per-token (ERC-20) caps are a later phase.
 *
 *      Mezo notes: this contract uses no PREVRANDAO/blockhash-history/blob
 *      opcodes (all diverge or are absent on Mezo). It must NOT be deployed in
 *      Mezo's precompile range (0x7b7c…): EIP-7702 rejects authorizations whose
 *      target is a precompile.
 */
contract SessionKeyDelegate {
    struct Session {
        bool exists;
        uint48 expiry; // unix seconds; 0 is treated as already-expired
        uint48 dayStart; // start of the current rolling 24h accounting window
        uint128 perTxCap; // max native value per single execute (wei)
        uint128 dailyCap; // max native value per rolling 24h window (wei)
        uint128 spentToday; // native value spent in the current window (wei)
    }

    /// @dev session key => scope
    mapping(address => Session) private _sessions;
    /// @dev session key => target => allowed
    mapping(address => mapping(address => bool)) private _allowed;

    event SessionRegistered(
        address indexed key,
        uint48 expiry,
        uint128 perTxCap,
        uint128 dailyCap,
        address[] targets
    );
    event SessionRevoked(address indexed key);
    event Executed(address indexed key, address indexed to, uint256 value, bytes data);

    error NotRoot();
    error UnknownSession();
    error SessionExpired();
    error TargetNotAllowed(address target);
    error PerTxCapExceeded(uint256 value, uint128 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint128 cap);
    error CallFailed(bytes ret);

    /**
     * @dev Only the account itself. Under EIP-7702 the delegate runs in the
     *      root EOA's context, so a transaction signed by the root and sent to
     *      itself has `msg.sender == address(this)`. No other caller (including
     *      any session key) can pass this guard.
     */
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotRoot();
        _;
    }

    /**
     * @notice Register (or overwrite) a session key and its scope.
     * @dev Root-only. Typically called by the account itself in the SAME
     *      type-0x04 transaction that installs the delegation.
     */
    function registerSession(
        address key,
        uint48 expiry,
        uint128 perTxCap,
        uint128 dailyCap,
        address[] calldata targets
    ) external onlySelf {
        _sessions[key] = Session({
            exists: true,
            expiry: expiry,
            dayStart: uint48(block.timestamp),
            perTxCap: perTxCap,
            dailyCap: dailyCap,
            spentToday: 0
        });
        for (uint256 i = 0; i < targets.length; i++) {
            _allowed[key][targets[i]] = true;
        }
        emit SessionRegistered(key, expiry, perTxCap, dailyCap, targets);
    }

    /// @notice Revoke a session key immediately. Root-only.
    function revokeSession(address key) external onlySelf {
        delete _sessions[key];
        emit SessionRevoked(key);
    }

    /// @notice Add/remove an allowlisted target for an existing session. Root-only.
    function setTarget(address key, address target, bool allowed) external onlySelf {
        _allowed[key][target] = allowed;
    }

    /**
     * @notice Execute a call from the account, authorized either by the root
     *         (self) with no limits, or by a registered session key within its
     *         on-chain scope.
     * @param to    target contract/EOA (must be allowlisted for a session key)
     * @param value native value to send (checked against caps for a session key)
     * @param data  calldata to forward
     */
    function execute(address to, uint256 value, bytes calldata data)
        external
        returns (bytes memory)
    {
        // Root path: the account itself can do anything (used for setup, sweeps,
        // and as the escape hatch). No caps — it is the owner.
        if (msg.sender == address(this)) {
            return _call(to, value, data);
        }

        // Session path: enforce scope on-chain.
        Session storage s = _sessions[msg.sender];
        if (!s.exists) revert UnknownSession();
        if (block.timestamp >= s.expiry) revert SessionExpired();
        if (!_allowed[msg.sender][to]) revert TargetNotAllowed(to);
        if (value > s.perTxCap) revert PerTxCapExceeded(value, s.perTxCap);

        // Rolling 24h window: reset the counter once the window elapses.
        if (block.timestamp >= uint256(s.dayStart) + 1 days) {
            s.dayStart = uint48(block.timestamp);
            s.spentToday = 0;
        }
        uint256 wouldSpend = uint256(s.spentToday) + value;
        if (wouldSpend > s.dailyCap) revert DailyCapExceeded(wouldSpend, s.dailyCap);
        // Checks-effects-interactions: record before the external call.
        s.spentToday = uint128(wouldSpend);

        bytes memory ret = _call(to, value, data);
        emit Executed(msg.sender, to, value, data);
        return ret;
    }

    function _call(address to, uint256 value, bytes calldata data)
        private
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getSession(address key)
        external
        view
        returns (
            bool exists,
            uint48 expiry,
            uint48 dayStart,
            uint128 perTxCap,
            uint128 dailyCap,
            uint128 spentToday
        )
    {
        Session storage s = _sessions[key];
        return (s.exists, s.expiry, s.dayStart, s.perTxCap, s.dailyCap, s.spentToday);
    }

    function isAllowed(address key, address target) external view returns (bool) {
        return _allowed[key][target];
    }

    /// @dev Accept native value (e.g. gas top-ups or swap proceeds routed back).
    receive() external payable {}
}

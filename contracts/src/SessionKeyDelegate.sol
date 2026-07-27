// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title SessionKeyDelegate
 * @notice EIP-7702 delegate for the Mezo agent. An account's root EOA installs
 *         this contract as its delegation designator (`0xef0100 || this`) via a
 *         type-0x04 authorization. Once installed the contract runs in the EOA's
 *         own storage/balance context and lets the root grant narrowly scoped,
 *         revocable "session keys" that execute calls WITHIN on-chain limits.
 *
 * @dev Trust model
 *      - The ROOT (the account itself) is the only manager. Management functions
 *        are guarded by `onlySelf` (`msg.sender == address(this)`), which under
 *        EIP-7702 self-execution means the account's own key signed the tx.
 *        Session keys can NEVER register or revoke sessions: `execute` forbids
 *        `to == address(this)` on the session path, so no session-relayed call
 *        can re-enter a management function as "self".
 *      - A SESSION KEY authorizes an op by being `msg.sender` — the tx's own
 *        ECDSA signature is the authorization. No 4337 machinery required.
 *
 * @dev What a compromised session key can do — enforced ON-CHAIN:
 *        1. Call only allowlisted targets, never this contract itself.
 *        2. Call only allowlisted FUNCTION SELECTORS on those targets.
 *        3. Move at most `perTxCap` native value per call and at most `dailyCap`
 *           within ANY trailing 24h (bucketed window — see `_windowUse`).
 *        4. Move at most `tokenPerTxCap` / `tokenDailyCap` of an ERC-20 per call
 *           and per trailing 24h. Amounts are DECODED from calldata for
 *           transfer/approve/transferFrom. `transferFrom` may only move THIS
 *           account's own tokens (`from == address(this)`), and the
 *           recipient/spender must be an allowlisted target that is not the
 *           token itself — so a key can neither approve an attacker nor drain a
 *           third party's allowance.
 *        5. Act only before `expiry`.
 *      A target carrying token caps may ONLY be granted the three decoded
 *      selectors, so no un-decoded (hence uncapped) value-moving selector can be
 *      configured on a token by mistake.
 *
 * @dev Known residual risk (documented, not hidden): revocation clears this
 *      contract's bookkeeping but cannot retroactively zero an ERC-20 allowance
 *      a session key already granted. That exposure is bounded — an approval may
 *      only ever name an allowlisted spender and may not exceed `tokenPerTxCap`
 *      — and the root can always sweep it via `execute(token, 0, approve(spender, 0))`.
 *      Operators should allowlist only trusted spenders (e.g. the canonical DEX
 *      router) as approve counterparties.
 *
 *      Mezo notes: uses no PREVRANDAO/blockhash-history/blob opcodes (all diverge
 *      or are absent on Mezo). MUST NOT be deployed in Mezo's precompile range
 *      (0x7b7c…): EIP-7702 rejects authorizations targeting a precompile.
 */
contract SessionKeyDelegate {
    // ─── Types ────────────────────────────────────────────────────────────────

    struct Session {
        bool exists;
        uint48 expiry; // unix seconds; 0 is treated as already-expired
        uint128 perTxCap; // max native value per single execute (wei)
        uint128 dailyCap; // max native value per trailing 24h (wei)
    }

    /// @notice Scope for one target: which selectors, and ERC-20 amount caps.
    struct TargetPolicy {
        address target;
        /// @dev Allowed function selectors. Empty => only zero-calldata (plain
        ///      value transfer) is permitted to this target.
        bytes4[] selectors;
        /// @dev Max decoded ERC-20 amount per call (0 => decoded transfers denied).
        uint128 tokenPerTxCap;
        /// @dev Max decoded ERC-20 amount per trailing 24h.
        uint128 tokenDailyCap;
    }

    /**
     * @dev Trailing-window accounting. Spend is bucketed into fixed
     *      `BUCKET_SECONDS` slots held in a ring of `BUCKET_COUNT` entries; a
     *      check sums the most recent `BUCKET_COUNT` buckets. Because
     *      `(BUCKET_COUNT - 1) * BUCKET_SECONDS == 24h`, every spend is counted
     *      for AT LEAST 24 hours before it can age out — so the cap can never be
     *      exceeded within any true trailing 24h (the earlier weighted
     *      two-bucket approximation allowed up to 2x and was replaced).
     *      Each bucket packs `idx` (high 32 bits) and `amount` (low 224 bits).
     */
    uint256 private constant BUCKET_SECONDS = 2 hours;
    uint256 private constant BUCKET_COUNT = 13; // (13-1) * 2h = 24h minimum coverage
    uint256 private constant AMOUNT_MASK = (uint256(1) << 224) - 1;

    // ERC-20 mutating selectors whose amount argument we decode and cap.
    bytes4 private constant SEL_TRANSFER = bytes4(keccak256("transfer(address,uint256)"));
    bytes4 private constant SEL_APPROVE = bytes4(keccak256("approve(address,uint256)"));
    bytes4 private constant SEL_TRANSFER_FROM = bytes4(keccak256("transferFrom(address,address,uint256)"));

    // ─── Storage ──────────────────────────────────────────────────────────────

    mapping(address => Session) private _sessions;
    /// @dev key => target => allowed
    mapping(address => mapping(address => bool)) private _allowed;
    /// @dev key => target => selector => allowed
    mapping(address => mapping(address => mapping(bytes4 => bool))) private _allowedSelector;
    /// @dev key => target => decoded-amount caps
    mapping(address => mapping(address => uint128)) private _tokenPerTxCap;
    mapping(address => mapping(address => uint128)) private _tokenDailyCap;
    /// @dev key => native spend ring
    mapping(address => uint256[BUCKET_COUNT]) private _nativeBuckets;
    /// @dev key => token => token spend ring
    mapping(address => mapping(address => uint256[BUCKET_COUNT])) private _tokenBuckets;
    /// @dev key => targets currently granted (scope can be fully replaced)
    mapping(address => address[]) private _keyTargets;
    /// @dev key => target => 1-based index into _keyTargets (0 = absent). Keeps
    ///      the array free of duplicates so revocation can never be gas-griefed.
    mapping(address => mapping(address => uint256)) private _targetIndex;
    /// @dev key => target => selectors granted (so they can be cleared too)
    mapping(address => mapping(address => bytes4[])) private _keySelectors;

    // ─── Events / errors ──────────────────────────────────────────────────────

    event SessionRegistered(address indexed key, uint48 expiry, uint128 perTxCap, uint128 dailyCap);
    event TargetPolicySet(address indexed key, address indexed target, bytes4[] selectors, uint128 tokenPerTxCap, uint128 tokenDailyCap);
    event TargetRemoved(address indexed key, address indexed target);
    event SessionRevoked(address indexed key);
    event Executed(address indexed key, address indexed to, uint256 value, bytes4 selector);

    error NotRoot();
    error UnknownSession();
    error SessionExpired();
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);
    error SelfTargetForbidden();
    error PerTxCapExceeded(uint256 value, uint128 cap);
    error DailyCapExceeded(uint256 wouldSpend, uint128 cap);
    error TokenPerTxCapExceeded(uint256 amount, uint128 cap);
    error TokenDailyCapExceeded(uint256 wouldSpend, uint128 cap);
    error SpenderNotAllowed(address spender);
    error ForeignSourceForbidden(address from);
    error UncappedSelectorOnToken(bytes4 selector);
    error MalformedCalldata();
    error AmountTooLarge();
    error CallFailed(bytes ret);

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotRoot();
        _;
    }

    // ─── Management (root-only) ───────────────────────────────────────────────

    /**
     * @notice Register (or fully REPLACE) a session key and its scope.
     * @dev The key's previous targets, selectors, caps and spend rings are
     *      cleared first, so re-registering with a narrower policy genuinely
     *      narrows it.
     */
    function registerSession(
        address key,
        uint48 expiry,
        uint128 perTxCap,
        uint128 dailyCap,
        TargetPolicy[] calldata policies
    ) external onlySelf {
        _clearScope(key);
        _sessions[key] = Session({exists: true, expiry: expiry, perTxCap: perTxCap, dailyCap: dailyCap});
        delete _nativeBuckets[key];
        for (uint256 i = 0; i < policies.length; i++) {
            _applyPolicy(key, policies[i]);
        }
        emit SessionRegistered(key, expiry, perTxCap, dailyCap);
    }

    /// @notice Add or replace one target's policy on an existing session. Root-only.
    function setTargetPolicy(address key, TargetPolicy calldata policy) external onlySelf {
        if (!_sessions[key].exists) revert UnknownSession();
        _clearTarget(key, policy.target);
        _applyPolicy(key, policy);
    }

    /// @notice Remove a target (and all its selectors/caps) from a session. Root-only.
    function removeTarget(address key, address target) external onlySelf {
        if (!_sessions[key].exists) revert UnknownSession();
        _clearTarget(key, target);
        emit TargetRemoved(key, target);
    }

    /// @notice Revoke a session key immediately and clear its entire scope. Root-only.
    function revokeSession(address key) external onlySelf {
        _clearScope(key);
        delete _sessions[key];
        delete _nativeBuckets[key];
        emit SessionRevoked(key);
    }

    // ─── Execution ────────────────────────────────────────────────────────────

    /**
     * @notice Execute a call from the account: unrestricted for the root (self),
     *         or bounded by on-chain scope for a registered session key.
     */
    function execute(address to, uint256 value, bytes calldata data)
        external
        returns (bytes memory)
    {
        // Root path: the account itself. No caps — it is the owner.
        if (msg.sender == address(this)) {
            return _call(to, value, data);
        }

        // A session key may never reach this contract's own selector space.
        if (to == address(this)) revert SelfTargetForbidden();

        Session storage s = _sessions[msg.sender];
        if (!s.exists) revert UnknownSession();
        if (block.timestamp >= s.expiry) revert SessionExpired();
        if (!_allowed[msg.sender][to]) revert TargetNotAllowed(to);

        // 1. Native value caps (per-tx + true trailing 24h).
        if (value > s.perTxCap) revert PerTxCapExceeded(value, s.perTxCap);
        if (value > 0) {
            uint256 used = _windowUse(_nativeBuckets[msg.sender], value);
            if (used > s.dailyCap) revert DailyCapExceeded(used, s.dailyCap);
        }

        // 2. Calldata policy: selector must be allowlisted, and any decodable
        //    ERC-20 amount is capped exactly like native value.
        bytes4 selector;
        if (data.length > 0) {
            if (data.length < 4) revert MalformedCalldata();
            selector = bytes4(data[:4]);
            if (!_allowedSelector[msg.sender][to][selector]) revert SelectorNotAllowed(selector);
            _enforceTokenPolicy(msg.sender, to, selector, data);
        }

        bytes memory ret = _call(to, value, data);
        emit Executed(msg.sender, to, value, selector);
        return ret;
    }

    /**
     * @dev Decode and cap ERC-20 value movement.
     *      - `transferFrom` may only move THIS account's tokens; a foreign
     *        `from` would let a key drain a third party's allowance.
     *      - The recipient/spender must be an allowlisted target and must not be
     *        the token itself (the token is trivially "allowlisted" as the call
     *        target, which would otherwise be a free pass).
     */
    function _enforceTokenPolicy(address key, address token, bytes4 selector, bytes calldata data) private {
        uint256 amount;
        address counterparty;

        if (selector == SEL_TRANSFER || selector == SEL_APPROVE) {
            if (data.length < 68) revert MalformedCalldata();
            (counterparty, amount) = abi.decode(data[4:68], (address, uint256));
        } else if (selector == SEL_TRANSFER_FROM) {
            if (data.length < 100) revert MalformedCalldata();
            address from;
            (from, counterparty, amount) = abi.decode(data[4:100], (address, address, uint256));
            if (from != address(this)) revert ForeignSourceForbidden(from);
        } else {
            return; // non-value-moving selector: already gated by the allowlist
        }

        if (counterparty == token) revert SpenderNotAllowed(counterparty);
        if (!_allowed[key][counterparty]) revert SpenderNotAllowed(counterparty);

        // A zero cap means "decoded transfers denied" — enforce that literally,
        // so a 0-amount call can't slip through a policy that denies transfers.
        uint128 perTx = _tokenPerTxCap[key][token];
        if (perTx == 0 || amount > perTx) revert TokenPerTxCapExceeded(amount, perTx);
        uint256 used = _windowUse(_tokenBuckets[key][token], amount);
        uint128 daily = _tokenDailyCap[key][token];
        if (used > daily) revert TokenDailyCapExceeded(used, daily);
    }

    // ─── Trailing-window accounting ───────────────────────────────────────────

    /**
     * @dev Add `amount` to the ring and return trailing-window usage (inclusive
     *      of `amount`). Buckets older than `BUCKET_COUNT` slots are excluded and
     *      are naturally overwritten when their slot comes round again.
     */
    function _windowUse(uint256[BUCKET_COUNT] storage ring, uint256 amount) private returns (uint256) {
        if (amount > AMOUNT_MASK) revert AmountTooLarge();
        uint256 cur = block.timestamp / BUCKET_SECONDS;
        uint256 total = amount;
        for (uint256 i = 0; i < BUCKET_COUNT; i++) {
            uint256 packed = ring[i];
            if (packed == 0) continue;
            uint256 idx = packed >> 224;
            // Counted while within the most recent BUCKET_COUNT buckets.
            if (idx <= cur && idx + BUCKET_COUNT > cur) {
                total += packed & AMOUNT_MASK;
            }
        }
        uint256 slot = cur % BUCKET_COUNT;
        uint256 slotPacked = ring[slot];
        uint256 prior = (slotPacked >> 224) == cur ? (slotPacked & AMOUNT_MASK) : 0;
        uint256 next = prior + amount;
        if (next > AMOUNT_MASK) revert AmountTooLarge();
        ring[slot] = (cur << 224) | next;
        return total;
    }

    /// @dev Read-only trailing-window usage (no state change).
    function _windowView(uint256[BUCKET_COUNT] storage ring) private view returns (uint256) {
        uint256 cur = block.timestamp / BUCKET_SECONDS;
        uint256 total;
        for (uint256 i = 0; i < BUCKET_COUNT; i++) {
            uint256 packed = ring[i];
            if (packed == 0) continue;
            uint256 idx = packed >> 224;
            if (idx <= cur && idx + BUCKET_COUNT > cur) total += packed & AMOUNT_MASK;
        }
        return total;
    }

    // ─── Internals ────────────────────────────────────────────────────────────

    function _applyPolicy(address key, TargetPolicy calldata p) private {
        if (p.target == address(this)) revert SelfTargetForbidden();
        bool isTokenTarget = p.tokenPerTxCap > 0 || p.tokenDailyCap > 0;
        if (_targetIndex[key][p.target] == 0) {
            _allowed[key][p.target] = true;
            _keyTargets[key].push(p.target);
            _targetIndex[key][p.target] = _keyTargets[key].length; // 1-based
        } else {
            _allowed[key][p.target] = true;
        }
        _tokenPerTxCap[key][p.target] = p.tokenPerTxCap;
        _tokenDailyCap[key][p.target] = p.tokenDailyCap;
        for (uint256 i = 0; i < p.selectors.length; i++) {
            bytes4 sel = p.selectors[i];
            // A target carrying token caps may only expose selectors we decode —
            // otherwise an un-decoded selector would move value uncapped.
            if (isTokenTarget && sel != SEL_TRANSFER && sel != SEL_APPROVE && sel != SEL_TRANSFER_FROM) {
                revert UncappedSelectorOnToken(sel);
            }
            if (!_allowedSelector[key][p.target][sel]) {
                _allowedSelector[key][p.target][sel] = true;
                _keySelectors[key][p.target].push(sel);
            }
        }
        emit TargetPolicySet(key, p.target, p.selectors, p.tokenPerTxCap, p.tokenDailyCap);
    }

    /// @dev Clear a target's mappings WITHOUT touching the `_keyTargets` array.
    function _clearTargetState(address key, address target) private {
        bytes4[] storage sels = _keySelectors[key][target];
        for (uint256 i = 0; i < sels.length; i++) {
            _allowedSelector[key][target][sels[i]] = false;
        }
        delete _keySelectors[key][target];
        _allowed[key][target] = false;
        _tokenPerTxCap[key][target] = 0;
        _tokenDailyCap[key][target] = 0;
        delete _tokenBuckets[key][target];
    }

    /// @dev Clear a target and remove it from the array (swap-and-pop), so the
    ///      array can never accumulate duplicates and grief revocation.
    function _clearTarget(address key, address target) private {
        _clearTargetState(key, target);
        uint256 oneBased = _targetIndex[key][target];
        if (oneBased == 0) return;
        address[] storage list = _keyTargets[key];
        uint256 i = oneBased - 1;
        uint256 lastIdx = list.length - 1;
        if (i != lastIdx) {
            address moved = list[lastIdx];
            list[i] = moved;
            _targetIndex[key][moved] = i + 1;
        }
        list.pop();
        _targetIndex[key][target] = 0;
    }

    function _clearScope(address key) private {
        address[] storage list = _keyTargets[key];
        for (uint256 i = list.length; i > 0; i--) {
            address t = list[i - 1];
            _clearTargetState(key, t);
            _targetIndex[key][t] = 0;
        }
        delete _keyTargets[key];
    }

    function _call(address to, uint256 value, bytes calldata data) private returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        return ret;
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function getSession(address key)
        external
        view
        returns (bool exists, uint48 expiry, uint128 perTxCap, uint128 dailyCap)
    {
        Session storage s = _sessions[key];
        return (s.exists, s.expiry, s.perTxCap, s.dailyCap);
    }

    function isAllowed(address key, address target) external view returns (bool) {
        return _allowed[key][target];
    }

    function isSelectorAllowed(address key, address target, bytes4 selector) external view returns (bool) {
        return _allowedSelector[key][target][selector];
    }

    function tokenCaps(address key, address token) external view returns (uint128 perTx, uint128 daily) {
        return (_tokenPerTxCap[key][token], _tokenDailyCap[key][token]);
    }

    function targetCount(address key) external view returns (uint256) {
        return _keyTargets[key].length;
    }

    /// @notice Trailing-window native usage for a key.
    function nativeUsage(address key) external view returns (uint256) {
        return _windowView(_nativeBuckets[key]);
    }

    /// @notice Trailing-window token usage for a key.
    function tokenUsage(address key, address token) external view returns (uint256) {
        return _windowView(_tokenBuckets[key][token]);
    }

    /// @dev Accept native value (gas top-ups, swap proceeds routed back).
    receive() external payable {}
}

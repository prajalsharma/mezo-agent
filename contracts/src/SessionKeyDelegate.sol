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
/**
 * ⚠️ NOT PRODUCTION-READY — /upgrade is DISABLED in the bot (UPGRADE_7702_ENABLED).
 *
 * A 12-agent security audit proved, with executable PoCs, that this delegate's
 * on-chain caps do NOT bound value in the general case:
 *   1. Token caps are enforced by decoding a hardcoded selector list, so any
 *      allowlisted spender holding a standing ERC-20 allowance moves funds with
 *      NOTHING charged to the ring. Enumerating selectors cannot close this.
 *   2. Native BTC and its 0x7b7C…0000 ERC-20 precompile are metered in two
 *      independent rings, so the daily BTC budget is effectively doubled.
 *   3. Router swap calldata (amountOutMin, Route.factory) is unconstrained, so a
 *      key can route its whole allowance through a pool it controls.
 *   4. setTargetPolicy clears the target's spend ring, so TIGHTENING a policy
 *      under attack refills the attacker's budget. registerSession does the same
 *      to BOTH the token rings and the native ring, so re-registering a key also
 *      refills it - the balance-delta rewrite must fix all three call sites.
 *   5. revokeSession/removeTarget have no caller in the bot, so a leaked key
 *      stays live until it expires (SESSION_TTL_DAYS). enableSmartAccount also
 *      mints a fresh key without revoking the previous one.
 *
 * CLOSED since that audit (kept here so the list stays honest about what moved):
 *   - Undecodable selectors used to hit `else { return; }`, a free pass, because
 *     the target allowlist gates who is CALLED and never who gets PAID. The
 *     default is now DENY, with an explicit per-target opt-in that is ignored on
 *     any target carrying token caps.
 *   - swapWithFee is now decoded: its feeBpsOverride must be 0, so a stolen key
 *     cannot burn up to MAX_OVERRIDE_BPS of the account's principal per swap.
 *
 * The correct fix is balance-delta accounting — snapshot the account's balance
 * of each capped token around `_call` and charge the realized decrease — which
 * is selector-agnostic. That is a rewrite, not a patch, and must be completed
 * and re-audited before this delegate is used with real funds.
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
        /// @dev Opt-in escape hatch for targets that expose selectors the policy
        ///      engine cannot decode (e.g. a plain payable call whose value is
        ///      already metered by the native ring). Default FALSE: an undecoded
        ///      selector is denied, because the target allowlist gates who is
        ///      CALLED and never who gets PAID. Setting this true on a target
        ///      that can move ERC-20s reopens that hole - do not.
        bool allowUndecodedSelectors;
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

    // Velodrome-style Router swap selectors. These are the selectors an operator
    // actually grants a session key, and every one carries a caller-chosen
    // `address to` recipient. Without decoding it, the contract's headline
    // guarantee — "the recipient must be an allowlisted target" — is enforced
    // ONLY for the three ERC-20 selectors above, and a key refused
    // `transfer(attacker, x)` achieves the identical transfer via
    // `swap(..., to: attacker, ...)`. (Audit finding, 3 independent agents.)
    //
    // ABI head layout is fixed even though `Route[]` is dynamic (the array is a
    // tail offset), so `to` sits at a constant word index per selector.
    bytes4 private constant SEL_SWAP_WITH_FEE = bytes4(
        keccak256("swapWithFee(uint256,uint256,(address,address,bool,address)[],uint256,address,uint16,uint16)")
    );
    bytes4 private constant SEL_ZAP_LEG_WITH_FEE = bytes4(
        keccak256("zapLegWithFee(uint256,uint256,(address,address,bool,address)[],uint256,address,uint16,uint16)")
    );
    bytes4 private constant SEL_SWAP_TOKENS_FOR_TOKENS =
        bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)"));
    bytes4 private constant SEL_SWAP_ETH_FOR_TOKENS =
        bytes4(keccak256("swapExactETHForTokens(uint256,(address,address,bool,address)[],address,uint256)"));
    bytes4 private constant SEL_SWAP_TOKENS_FOR_ETH =
        bytes4(keccak256("swapExactTokensForETH(uint256,uint256,(address,address,bool,address)[],address,uint256)"));


    // ─── Storage ──────────────────────────────────────────────────────────────

    mapping(address => Session) private _sessions;
    /// @dev key => target => allowed
    mapping(address => mapping(address => bool)) private _allowed;
    /// @dev key => target => selector => allowed
    mapping(address => mapping(address => mapping(bytes4 => bool))) private _allowedSelector;
    /// @dev key => target => decoded-amount caps
    mapping(address => mapping(address => uint128)) private _tokenPerTxCap;
    mapping(address => mapping(address => uint128)) private _tokenDailyCap;
    mapping(address => mapping(address => bool)) private _allowUndecoded;
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
    /// A selector the policy engine cannot decode is never safe to allow: the
    /// target allowlist gates who is CALLED, never who gets PAID.
    error UndecodableSelector(bytes4 selector);
    error FeeOverrideForbidden(uint16 bps);
    error DuplicateTarget();
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
            // Reject duplicate targets. Selectors ACCUMULATE across entries while
            // `isTokenTarget` is evaluated per entry, so naming one target twice
            // (first with zero caps carrying an un-decoded selector, then with
            // caps) would union them and defeat the UncappedSelectorOnToken
            // guard — leaving an uncapped value-moving selector on a capped
            // token. setTargetPolicy is immune because it _clearTarget()s first;
            // this loop is the only path that could union. (Audit finding.)
            if (_targetIndex[key][policies[i].target] != 0) revert DuplicateTarget();
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
        } else if (
            selector == SEL_SWAP_TOKENS_FOR_TOKENS || selector == SEL_SWAP_TOKENS_FOR_ETH
                || selector == SEL_SWAP_ETH_FOR_TOKENS
        ) {
            // Swap proceeds must come back to THIS account. `to` is the 4th head
            // word for the two-amount variants and the 3rd for the ETH variant.
            uint256 off = selector == SEL_SWAP_ETH_FOR_TOKENS ? 68 : 100;
            if (data.length < off + 32) revert MalformedCalldata();
            address to = abi.decode(data[off:off + 32], (address));
            if (to != address(this)) revert SpenderNotAllowed(to);
            return; // amount is metered by the approval that funds the swap
        } else if (selector == SEL_SWAP_WITH_FEE || selector == SEL_ZAP_LEG_WITH_FEE) {
            // The FeeRouter hardcodes the payout to msg.sender, so proceeds
            // cannot be redirected - but `referrer` and `feeBpsOverride` are
            // caller-chosen. The FeeRouter only pays a referrer it has BOUND to
            // this trader, so the referrer leg is already inert for a stolen
            // key; the override is not, and lets a key burn up to
            // MAX_OVERRIDE_BPS of the account's own principal per swap.
            // feeBpsOverride is head word 6 (offset 4 + 6*32).
            if (data.length < 228) revert MalformedCalldata();
            uint16 feeBpsOverride = uint16(uint256(bytes32(data[196:228])));
            if (feeBpsOverride != 0) revert FeeOverrideForbidden(feeBpsOverride);
            return; // amount is metered by the approval that funds the swap
        } else {
            // DEFAULT DENY. This branch used to `return`, on the theory that an
            // unrecognised selector could not move value - false: the allowlist
            // constrains the CALLEE, never the PAYEE, so any undecoded selector
            // carrying a `to`/`referrer` word was a free pass (audit, 4 agents).
            // Adding a selector to a policy now requires teaching the decoder.
            // The hatch may only pass a NO-ARGUMENT call. Four bytes of
            // calldata cannot carry a recipient or an amount, so value movement
            // is limited to `value`, which the native ring already meters.
            // Waving through arbitrary arguments re-opened the hole on exactly
            // the targets holding standing allowances - Router and FeeRouter are
            // configured with zero token caps, so `isTokenTarget` is false for
            // them and the interlock would not have fired (audit).
            if (!_allowUndecoded[key][token] || data.length != 4) revert UndecodableSelector(selector);
            return;
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
        // A target with token caps can move ERC-20s; the escape hatch must never
        // apply there, whatever the caller passed.
        _allowUndecoded[key][p.target] = p.allowUndecodedSelectors && !isTokenTarget;
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

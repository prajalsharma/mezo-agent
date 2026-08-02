### contracts/src/SessionKeyDelegate.sol
```solidity
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
        } else if (selector == SEL_SWAP_WITH_FEE) {
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
            if (!_allowUndecoded[key][token]) revert UndecodableSelector(selector);
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
```

### contracts/src/FeeRouter.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Velodrome/Aerodrome-style route hop (matches Mezo's Router V2).
struct Route {
    address from;
    address to;
    bool stable;
    address factory;
}

interface IVeloRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/**
 * FeeRouter — atomic swap + agent fee in ONE transaction.
 *
 * Why this exists: the Telegram agent's fee used to be a SEPARATE transaction
 * after the swap, so a transient RPC failure could collect the user's swap but
 * lose the operator's fee. Routing the swap through this contract makes the two
 * inseparable: if the swap reverts the fee reverts with it (user-fair), and if
 * the swap succeeds the fee is already collected (revenue-safe) — the same
 * atomicity a marketplace contract gets for its protocol fee.
 *
 * Design notes:
 *  - ESCROWLESS: swap output goes straight from the pool to the user
 *    (`to = msg.sender`); this contract holds funds only transiently within the
 *    transaction and keeps no balances or per-user state.
 *  - On Mezo, native BTC is an ERC-20 at the 0x7b7C…0000 precompile, so EVERY
 *    input token — BTC included — uses the same transferFrom path. No payable
 *    variant is needed.
 *  - Referral split at source: an optional referrer receives a share of the fee
 *    in the same transaction, capped by an owner-set maximum so a caller cannot
 *    redirect more than the configured share.
 *  - Fee is hard-capped at 1% (MAX_FEE_BPS), matching the agent's off-chain cap.
 */
contract FeeRouter {
    uint16 public constant MAX_FEE_BPS = 100; // 1% — cap on the DEFAULT rate
    /// @dev Per-call override ceiling. 2× MAX_FEE_BPS exists solely for zap
    ///      half-leg accounting (2× bps on half the input == bps on the gross);
    ///      an override only lets the CALLER volunteer a higher rate on their
    ///      own call — the default every plain swap pays stays capped at 1%.
    uint16 public constant MAX_OVERRIDE_BPS = 200;
    uint16 public constant BPS = 10_000;

    IVeloRouter public immutable router;
    address public owner;
    address public feeRecipient;
    uint16 public feeBps;
    /// @dev Discounted rate REFERRED traders pay (owner-set, must be <= feeBps;
    ///      0 disables the discount). This exists because the fee floor below
    ///      must not make the advertised lifetime referral discount
    ///      unrepresentable — a floor of `feeBps` alone would revert every
    ///      referred swap. (Audit finding: the first floor fix broke the
    ///      referral program outright.)
    uint16 public referredFeeBps;
    /// @dev Max share of the fee (in bps of the fee) a referrer may receive.
    uint16 public maxReferralShareBps;
    /**
     * @dev Owner-attested referrers. `referrer` is unauthenticated calldata, so
     *      without this ANY caller could name an address to (a) unlock the
     *      discounted floor with no referral at all, and (b) rebate the referral
     *      share to a second wallet they control. Comparing against msg.sender
     *      is not enough — one throwaway EOA defeats it, and under EIP-7702
     *      msg.sender is the user's own account so the comparison is
     *      structurally inapplicable. Only registered referrers unlock either
     *      the discount or the payout. (Audit: 4 independent agents.)
     */
    /**
     * @dev trader => the ONE referrer that trader is bound to.
     *      A global "is this address a referrer" flag is NOT enough (audit):
     *      the flag proves an address is *a* referrer, never that it is *this
     *      trader's* referrer - so any caller could read the public mapping,
     *      name a stranger's attested address, and take the discount plus a
     *      rebate to an address they collude with. The binding is the relation
     *      itself, so a referral cannot be self-asserted from calldata.
     */
    mapping(address => address) public referrerOf;
    /**
     * @dev Tokens the fee may be denominated in. The fee is bps of
     *      `routes[0].from`, which is CALLER-CHOSEN — so without this an
     *      attacker mints a worthless token, makes it hop 0, and has the real
     *      trade settle on a later hop: every rate check still passes because
     *      they constrain the RATE, never the UNIT the rate applies to.
     *      Result: the operator is paid in dust. (Audit finding.)
     *      Empty set = unconfigured = allow all (so a fresh deploy is not
     *      bricked); the deploy script populates it immediately.
     */
    mapping(address => bool) public isFeeToken;
    uint256 public feeTokenCount;
    /// @dev True once setReferredFeeBps is called, so setConfig stops
    ///      overwriting a deliberately-chosen promo rate.
    bool public referredFeeBpsPinned;

    bool private _entered;

    event SwappedWithFee(
        address indexed user,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 fee,
        address indexed referrer,
        uint256 referrerShare
    );
    event ConfigChanged(address feeRecipient, uint16 feeBps, uint16 maxReferralShareBps);
    event OwnerChanged(address indexed newOwner);
    event ReferrerBound(address indexed trader, address indexed referrer);
    event FeeTokenSet(address indexed token, bool allowed);
    event ReferredFeeBpsChanged(uint16 referredFeeBps);

    error NotOwner();
    error Reentered();
    error FeeTooHigh();
    error ZeroAddress();
    error EmptyRoute();
    error TransferFailed();
    error FeeTokenNotAllowed(address token);
    error NotAContract(address token);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered) revert Reentered();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address router_, address feeRecipient_, uint16 feeBps_, uint16 maxReferralShareBps_) {
        if (router_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS || maxReferralShareBps_ > BPS) revert FeeTooHigh();
        router = IVeloRouter(router_);
        owner = msg.sender;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        referredFeeBps = uint16((uint256(feeBps_) * 90) / 100); // default 90% of headline
        maxReferralShareBps = maxReferralShareBps_;
    }

    /**
     * Pull `amountIn` of routes[0].from from the caller, keep the fee (split
     * with `referrer` when provided), swap the remainder via the Mezo Router,
     * and deliver the output DIRECTLY to the caller. Reverts as a unit.
     *
     * @param referralShareBps referrer's share of the fee, in bps of the fee;
     *        clamped to `maxReferralShareBps`. Ignored when referrer is zero.
     * @param feeBpsOverride optional per-call fee rate; 0 uses the default
     *        `feeBps`. Bounded on BOTH sides: `feeBps <= override <= MAX_OVERRIDE_BPS`.
     *        The upper 2× headroom exists solely so a zap can collect its WHOLE
     *        fee on the swapped half (2× bps on half == bps on gross); the lower
     *        bound is what makes "a caller may only volunteer a HIGHER rate"
     *        true — without it any caller could set 1 bps and underpay the fee
     *        (audit finding: an under-collection can never be caught by
     *        `amountOutMin`, because a smaller fee means MORE output, not less).
     */
    function swapWithFee(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        uint256 deadline,
        address referrer,
        uint16 referralShareBps,
        uint16 feeBpsOverride
    ) external nonReentrant returns (uint256 amountOut) {
        return _swap(amountIn, amountOutMin, routes, deadline, referrer, referralShareBps, feeBpsOverride, 1);
    }

    /**
     * @notice The swap leg of a zap. A zap charges the whole zap's fee on the
     *         HALF that gets swapped, so its correct rate is 2x the plain-swap
     *         rate. `swapWithFee` cannot tell a zap leg apart from a normal
     *         swap, so its floor was the single rate - letting anyone route a
     *         zap through it and pay half the intended fee (audit). This
     *         entrypoint doubles the floor so the leg kind is no longer
     *         calldata the caller chooses.
     */
    function zapLegWithFee(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        uint256 deadline,
        address referrer,
        uint16 referralShareBps,
        uint16 feeBpsOverride
    ) external nonReentrant returns (uint256 amountOut) {
        return _swap(amountIn, amountOutMin, routes, deadline, referrer, referralShareBps, feeBpsOverride, 2);
    }

    function _swap(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        uint256 deadline,
        address referrer,
        uint16 referralShareBps,
        uint16 feeBpsOverride,
        uint16 floorMultiplier
    ) private returns (uint256 amountOut) {
        if (routes.length == 0) revert EmptyRoute();
        // Two-sided bound. The FLOOR is the discounted rate only when a genuine
        // (non-self) referrer is named and a discount is configured — otherwise
        // it is the full rate. This blocks the "pass 1 bps and underpay" attack
        // WITHOUT breaking the advertised referred-trader discount.
        _checkFloor(referrer, referralShareBps, feeBpsOverride, floorMultiplier);
        address tokenIn = routes[0].from;
        // The fee's UNIT must be trustworthy, not just its rate. Once fee tokens
        // are configured, hop 0 must be one of them.
        if (feeTokenCount != 0 && !isFeeToken[tokenIn]) revert FeeTokenNotAllowed(tokenIn);
        _requireContract(tokenIn);

        _pull(tokenIn, msg.sender, amountIn);
        uint256 fee = _takeFee(tokenIn, amountIn, referrer, referralShareBps, feeBpsOverride);

        _approve(tokenIn, address(router), amountIn - fee);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(amountIn - fee, amountOutMin, routes, msg.sender, deadline);
        amountOut = amounts[amounts.length - 1];
    }

    /// @dev The rate this caller actually pays before any override: the
    ///      discounted rate for an attested referral, otherwise the headline.
    ///      Used for BOTH the floor and the charged amount, so the discount is
    ///      a RATE, not merely a lower bound. (Audit: previously referredFeeBps
    ///      was only a floor, so a genuine referral calling with override=0 paid
    ///      FULL price while an attacker who passed the override got the
    ///      discount — exactly inverted.)
    /// @dev Two-sided bound on the caller-supplied rate. The FLOOR is the
    ///      discounted rate only for a trader BOUND to the named referrer,
    ///      otherwise the full rate - and 2x that for a zap leg, whose fee
    ///      covers the un-swapped half too.
    function _checkFloor(address referrer, uint16 referralShareBps, uint16 feeBpsOverride, uint16 floorMultiplier)
        private
        view
    {
        if (feeBpsOverride == 0) return; // 0 => the contract picks the rate
        uint256 rawFloor = uint256(_baseBps(referrer, referralShareBps)) * floorMultiplier;
        uint16 floorBps = rawFloor > MAX_OVERRIDE_BPS ? MAX_OVERRIDE_BPS : uint16(rawFloor);
        if (feeBpsOverride > MAX_OVERRIDE_BPS || feeBpsOverride < floorBps) revert FeeTooHigh();
    }

    function _baseBps(address referrer, uint16 referralShareBps) private view returns (uint16) {
        return (_referralActive(referrer, referralShareBps) && referredFeeBps != 0) ? referredFeeBps : feeBps;
    }

    /// @dev A referral is only real when the referrer is owner-attested, is not
    ///      the caller, and an actual share is being paid. The discounted FLOOR
    ///      and the PAYOUT must agree on this — gating them on different
    ///      conditions let callers take the discount while paying no referrer.
    function _referralActive(address referrer, uint16 referralShareBps) private view returns (bool) {
        return referrer != address(0) && referrer != msg.sender && referrerOf[msg.sender] == referrer && referralShareBps > 0;
    }

    /// @dev Split the fee between referrer (clamped share) and the operator.
    function _takeFee(address tokenIn, uint256 amountIn, address referrer, uint16 referralShareBps, uint16 bpsOverride)
        private
        returns (uint256 fee)
    {
        // Same base as the floor: an attested referral is CHARGED the discount
        // even when the caller passes no override.
        uint16 base = _baseBps(referrer, referralShareBps);
        fee = (amountIn * (bpsOverride > 0 ? bpsOverride : base)) / BPS;
        uint256 referrerShare = 0;
        if (fee > 0) {
            // Self-referral is rejected: `referrer` is unauthenticated calldata,
            // so without this any caller could name THEMSELVES and rebate
            // maxReferralShareBps of their own fee — a permanent discount to
            // anyone who reads the ABI (audit finding). Referrals are a growth
            // incentive for bringing OTHER traders, never a self-discount.
            if (_referralActive(referrer, referralShareBps)) {
                uint16 share = referralShareBps > maxReferralShareBps ? maxReferralShareBps : referralShareBps;
                referrerShare = (fee * share) / BPS;
                if (referrerShare > 0) _push(tokenIn, referrer, referrerShare);
            }
            uint256 operatorShare = fee - referrerShare;
            if (operatorShare > 0) _push(tokenIn, feeRecipient, operatorShare);
        }
        emit SwappedWithFee(msg.sender, tokenIn, amountIn, fee, referrer, referrerShare);
    }

    // ── Owner controls ────────────────────────────────────────────────────────

    function setConfig(address feeRecipient_, uint16 feeBps_, uint16 maxReferralShareBps_) external onlyOwner {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS || maxReferralShareBps_ > BPS) revert FeeTooHigh();
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        // RE-DERIVE, never one-way clamp: clamping only downward meant a
        // temporary promo (fee 100 -> 40) permanently latched the discounted
        // floor at 40 even after the headline returned to 100. (Audit finding.)
        // Only re-derive when the owner has never set the referred rate
        // explicitly. The previous unconditional re-derivation silently
        // discarded setReferredFeeBps on any unrelated change (e.g. rotating
        // the fee recipient), which could brick referred swaps (audit).
        if (!referredFeeBpsPinned) {
            referredFeeBps = uint16((uint256(feeBps_) * 90) / 100);
            emit ReferredFeeBpsChanged(referredFeeBps);
        } else if (referredFeeBps > feeBps_) {
            // A pinned discount must never exceed the headline rate.
            referredFeeBps = feeBps_;
            emit ReferredFeeBpsChanged(referredFeeBps);
        }
        maxReferralShareBps = maxReferralShareBps_;
        emit ConfigChanged(feeRecipient_, feeBps_, maxReferralShareBps_);
    }

    /// @notice Set the discounted rate referred traders pay (<= feeBps; 0 disables).
    function setReferredFeeBps(uint16 bps) external onlyOwner {
        if (bps > feeBps) revert FeeTooHigh();
        referredFeeBps = bps;
        referredFeeBpsPinned = true; // setConfig must stop re-deriving over this
        emit ReferredFeeBpsChanged(bps);
    }

    /// @notice Attest (or revoke) referrers in bulk. Only these unlock the
    ///         discounted rate and the referral payout.
    /// @notice Bind traders to the referrer that actually referred them.
    /// @dev Must be called before a referred trade or the trade pays full price
    ///      and the referrer is paid nothing. The bot calls this at referral
    ///      signup (src/core/referralBinding.ts) so the registry cannot go stale.
    function bindReferrers(address[] calldata traders, address referrer) external onlyOwner {
        if (referrer == address(0)) revert ZeroAddress();
        for (uint256 i = 0; i < traders.length; i++) {
            if (traders[i] == address(0)) revert ZeroAddress();
            referrerOf[traders[i]] = referrer;
            emit ReferrerBound(traders[i], referrer);
        }
    }

    /// @notice Set which tokens the fee may be charged in (hop 0 of a route).
    function setFeeTokens(address[] calldata tokens, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) revert ZeroAddress();
            if (isFeeToken[tokens[i]] != allowed) {
                isFeeToken[tokens[i]] = allowed;
                if (allowed) feeTokenCount++;
                else feeTokenCount--;
            }
            emit FeeTokenSet(tokens[i], allowed);
        }
    }

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    /// @notice Rescue tokens accidentally sent here (the contract never holds
    ///         balances by design, so anything sitting here is stuck dust).
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _push(token, to, amount);
    }

    // ── Minimal safe-ERC20 (handles missing/false return values) ─────────────

    /// @dev A low-level call to an address with NO CODE returns ok=true with
    ///      empty returndata, which the success check below reads as a
    ///      successful transfer. Without this, a caller could pass a codeless
    ///      address as routes[0].from and emit a fully successful-looking
    ///      SwappedWithFee with zero tokens moved, poisoning volume and
    ///      referral analytics (audit).
    function _requireContract(address token) private view {
        uint256 size;
        assembly { size := extcodesize(token) }
        if (size == 0) revert NotAContract(token);
    }

    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, address(this), amount)); // transferFrom
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount)); // approve
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
```
# Senior Auditor's Mindset

This is how a senior auditor thinks. Pattern-matching catches the obvious bugs — your specialty file teaches that. The high-value bugs, the ones everyone else misses, come from HOW you reason about code, not from WHAT bugs you know.

The senior auditor's edge is not "knowing more bug patterns" — it is having internalized mental tools they reach for instinctively when something feels off, when a path seems clean, or when a conclusion comes too quickly.

This file gives you three tools. They are not steps. You reach for the right one the moment the trigger fires — see `shared-rules.md` for the binding trigger→tool protocol. Use them. Trust your discomfort.

A finding is not real until you've traced the attack with concrete values. You are an attacker, not a defender — when you find a bug, deepen the attack; never argue yourself out of one.

---

## 1. The Feynman test (FIRST — use it before anything else)

**This is the first tool. Apply it the moment you open any new function or contract — before you reason about anything else.** Code you have not Feynman'd is code you have not actually understood.

When you read code, STOP and ask: "Can I explain what this function does to someone who doesn't know Solidity?"

Try it. In plain words. The places where your explanation gets fuzzy — where you reach for Solidity jargon instead of plain meaning — are where you're papering over an assumption. That's where bugs hide.

Example: you read `_handleFeeTransfer(zrc20, fee)` and your explanation comes out as "it transfers the fee." That's not Feynman. Feynman is: "it picks up the protocol's commission off the user's payment and moves it to the treasury wallet." Now keep going: what if the payment is in ETH and the function uses an ERC20 method? Your plain-English explanation breaks. Bug.

A senior auditor doesn't trust their understanding until they can explain it without the safety net of technical vocabulary.

---

## 2. Socratic questioning

For every line of code, ask: why is this here? What does it assume? What happens if the assumption breaks?

Don't accept "because that's how it's written" as an answer. Don't accept "the function name says so" as an answer. Drill until you reach the implicit belief the code rests on. The first answer is usually a restatement. The actual assumption is two or three "whys" deeper.

Example: `if (zrc20 != _ETH_ADDRESS_) IERC20(zrc20).transferFrom(msg.sender, address(this), amount);`
- Why is `zrc20 != _ETH_ADDRESS_` checked? → because ETH isn't transferable via transferFrom.
- Why is there no else branch? → because the developer assumed ETH arrives via `msg.value`.
- Where is `msg.value` enforced to equal `amount` for the ETH path? → **nowhere**. Bug.

A senior auditor accepts no "because" without examining it.

---

## 3. Inversion

Every clean path gets a backward pass. After you understand what the code IS supposed to do, ask: how would I make it NOT do that?

Same code, attacker's eye instead of developer's eye. The developer asks "does this work?" The attacker asks "how do I break this?" Read every check and ask "what value slips past it?" Read every state update and ask "what state am I in just before this?"

A senior auditor never reads code only forward.

---

## When to reach for which tool

You don't apply these in order — except Feynman, which is always first. You reach for what the moment calls for:

- Opening any new function or contract → **Feynman** (always — before anything else)
- Trying to understand a line you don't yet → **Socratic**
- Something looks too clean → **Inversion**
- You reached a "bug" conclusion → amplify the attack (chain it, find more victims, lower the precondition cost — do NOT refute it)

The tools are how you keep yourself honest. Without them, you fall into the trap of every junior auditor: trusting your first read, accepting code that "looks right," moving on when something feels off.

Trust your discomfort. Reach for the tool. Don't stop until the discomfort has a name.
# Execution Trace Agent

You are an attacker that exploits execution flow — tracing from entry point to final state through encoding, storage, branching, external calls, and state transitions. Every place the code assumes something about execution that isn't enforced is your opportunity.

Other agents cover known patterns, arithmetic, permissions, economics, invariants, periphery, and first-principles. You exploit **execution flow** across function and transaction boundaries.

## Within a transaction

- **Parameter divergence.** Feed mismatched inputs: claimed amount ≠ actual sent amount, requested token ≠ delivered token. Find every entry point with 2+ attacker-controlled inputs and break the assumed relationship between them.
- **Value leaks.** Trace every value-moving function from entry to final transfer. Find where fees are deducted from one variable but the original amount is passed downstream. Deposit token A, specify token B in the message, drain the contract's B balance. Forward full `msg.value` after fee subtraction.
- **Encoding/decoding mismatches.** Exploit `abi.encodePacked` decoded with `abi.decode`, field order mismatches, assembly reading wrong byte counts.
- **Sentinel bypass.** `address(0)`, `0xEeEe...`, `type(uint256).max`, empty bytes trigger special paths. Find where the special path skips validation the normal path enforces.
- **Untrusted return values.** Exploit external call return values used without validation. Find where the query function differs from the function used for the actual operation.
- **Stale reads.** Read a value, modify state or make an external call, then exploit the now-stale value.
- **Partial state updates.** Find functions that update coupled variables but can revert or return early mid-update. Exploit the inconsistent intermediate state.

## Across transactions

- **Wrong-state execution.** Execute functions in protocol states they were never designed for.
- **Operation interleaving.** Corrupt multi-step operations (request → wait → execute) by acting between steps.
- **Cross-message field manipulation.** In bridges/callbacks/queues, corrupt individual packed fields across legs.
- **Mid-operation config mutation.** Fire a setter while an operation is in-flight. Exploit the operation consuming stale or unexpected new values.
- **Dependency swap.** Swap an external dependency while a callback from the old one is still pending.
- **Approval residuals.** Exploit leftover allowance when approved amount exceeds consumed amount.

## Output fields

Add to FINDINGs:
```
input: which parameter(s) you control and what values you supply
assumption: the implicit assumption you violated
proof: concrete trace from entry to impact with specific values
```
# Shared Scan Rules

## Bundle contents

Your bundle is four concatenated files: all in-scope source code, the SOP (HOW to think), your specialty agent (WHAT to look for), and these shared rules (output format, dedup tags, AND mandatory mental tool protocol).

Read the whole bundle once at the start. The bundle contains all in-scope source. Use Read/Grep only for cross-file searches or out-of-scope context (interfaces/, lib/, mocks/, test/) — do not re-read in-scope files for the initial scan.

**The protocol below applies continuously during source reading — not just before it.** The "read source" phase does not turn off the protocol; every trigger condition fires the moment it occurs, throughout your entire review.

When matching function names, check both `functionName` and `_functionName` (Solidity convention).

## Mental tool protocol — MANDATORY

The three tools in `senior-auditor-sop.md` are NOT optional. Each tool has a specific trigger. **When the trigger fires, you MUST emit the corresponding marker in your output stream BEFORE continuing.** No skipping. The markers live in your working text — they do NOT go into the FINDING/LEAD output blocks.

### Triggers → required markers

| Trigger (the condition) | Marker (required immediately, literal `[Tool: ...]` syntax) | Content |
|---|---|---|
| You open a new function or contract to read | `[Feynman: <name>]` | Explain what it does in plain English — no Solidity jargon, no `mload`/`assembly`/`mstore`/`safeTransfer`/etc. Use as many sentences as you need until the explanation is solid. If your wording slips back to jargon, you're papering over an assumption — keep going. Wherever your plain-English explanation gets fuzzy or you have to reach for a Solidity term to keep it accurate, mark that spot — that is where bugs hide. |
| You stop on a line whose purpose isn't immediately clear | `[Socratic: <file:line> — why?]` | A one-line question that drills past "because that's how it's written." If your first answer is a restatement of the code, ask again. Stop when the answer exposes the implicit belief the code rests on — don't pad with extra steps just to hit a quota. |
| A code path reads as clean / a check looks sufficient / a guard looks correct | `[Inversion: <function>]` | Three concrete attacker moves that attempt to defeat the path. Specific addresses/values/states, not abstractions. |

### Rules

1. **Triggers are not optional.** If the condition fires, the marker follows. Always. No skipping.
2. **Use the literal `[Tool: ...]` syntax.** The orchestrator greps your output for these tags after the run.
3. **You may emit a marker without a trigger.** Extra Feynman / Inversion markers are fine. You may NOT skip a marker after its trigger fired.
4. **The protocol applies to reasoning depth, not output volume.** Heavy use of these tools is what produces the audit work. Skipping them = surface-level scanning, which is the failure mode of every junior auditor.

The orchestrator verifies marker counts after every run. Skipped markers downgrade the value of your findings and are recorded as workflow violations.

## Cross-contract patterns

When you find a bug in one contract, **weaponize that pattern across every other contract in the bundle.** Search by function name AND by code pattern. Finding native/ERC20 confusion in `ContractA.onRevert` means you check every other contract's `onRevert` — missing a repeat instance is an audit failure.

After scanning: escalate every finding to its worst exploitable variant (DoS may hide fund theft). Then revisit every function where you found something and attack the other branches.

## Do not report

Admin-only functions doing admin things. Standard DeFi tradeoffs (MEV, rounding dust, first-depositor with MINIMUM_LIQUIDITY). Self-harm-only bugs. "Admin can rug" without a concrete mechanism.

## Output

Return findings as structured blocks:

FINDINGs have concrete, unguarded, exploitable attack paths. LEADs have real code smells with partial paths — default to LEAD over dropping.

**Every FINDING must have a `proof:` field** — concrete values, traces, or state sequences from the actual code. No proof = LEAD, no exceptions.

**One vulnerability per item.** Same root cause = one item. Different fixes needed = separate items.

```
FINDING | contract: Name | function: func | bug_class: kebab-tag | group_key: Contract | function | bug-class
path: caller → function → state change → impact
proof: concrete values/trace demonstrating the bug
description: one sentence
fix: one-sentence suggestion

LEAD | contract: Name | function: func | bug_class: kebab-tag | group_key: Contract | function | bug-class
code_smells: what you found
description: one sentence explaining trail and what remains unverified
```

The `group_key` enables deduplication: `ContractName | functionName | bug_class`. Agents may add custom fields.

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
    /// @dev Ceiling on the referrer's cut of each fee. `> BPS` admitted exactly
    ///      10000, i.e. 100% of every fee to referrers and nothing to the
    ///      operator — a config that reads as valid and silently zeroes revenue.
    ///      Half is far above any real referral programme.
    uint16 public constant MAX_REFERRAL_SHARE_BPS = 5000;
    /// @dev Largest legitimate leg multiplier: a zap leg pays for BOTH halves on
    ///      the half it swaps. Used for the override CEILING, independent of
    ///      which entrypoint was called — see _ceilingBps.
    uint16 public constant MAX_LEG_MULTIPLIER = 2;
    uint16 public constant BPS = 10_000;

    IVeloRouter public immutable router;
    address public owner;
    /// @dev Named successor awaiting acceptOwnership(). Zero when none pending.
    address public pendingOwner;
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
     *      Empty set = unconfigured = allow all, so a fresh deploy is not
     *      bricked. THAT WINDOW IS REAL AND MUST BE CLOSED BY THE OPERATOR:
     *      nothing in this contract or in Deploy.s.sol arms the gate, and until
     *      `npm run bindreferrers -- --apply` lands successfully the fee's UNIT
     *      is caller-chosen. It must be armed with the ROUTING addresses (BTC's
     *      is its 0x7b7C…0000 precompile, not its zero sentinel) — arming it
     *      with the wrong ones latches the gate on and reverts every BTC swap,
     *      and the latch never clears.
     */
    mapping(address => bool) public isFeeToken;
    uint256 public feeTokenCount;
    /// @dev Latches TRUE the first time fee tokens are allowed and never clears.
    ///      Gating on `feeTokenCount != 0` meant removing the last entry - the
    ///      most restrictive action an owner can take - turned the allowlist OFF
    ///      instead of denying everything (audit).
    bool public feeTokenGateEnabled;
    /// @dev True once setReferredFeeBps is called, so setConfig stops
    ///      overwriting a deliberately-chosen promo rate.
    bool public referredFeeBpsPinned;
    /// @dev The owner's INTENDED referred rate. referredFeeBps is the effective
    ///      rate, clamped to feeBps; keeping them separate is what stops a promo
    ///      from permanently latching the discount.
    uint16 public pinnedReferredFeeBps;

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
    event OwnershipTransferStarted(address indexed from, address indexed to);
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
        if (feeBps_ > MAX_FEE_BPS || maxReferralShareBps_ > MAX_REFERRAL_SHARE_BPS) revert FeeTooHigh();
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
     * @param referralShareBps IGNORED. Retained for ABI compatibility only: the
     *        referrer's share is owner state (maxReferralShareBps), because a
     *        trader-chosen share let the trader starve their own referrer.
     *        clamped to `maxReferralShareBps`. Ignored when referrer is zero.
     * @param feeBpsOverride optional per-call fee rate; 0 uses the default
     *        `feeBps`. Bounded on BOTH sides: the floor is what this caller
     *        would owe anyway, and the ceiling is MAX_LEG_MULTIPLIER x the
     *        CONFIGURED `feeBps` (never the bare MAX_OVERRIDE_BPS constant, or
     *        lowering feeBps would not lower what a caller may charge).
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
        _checkFloor(referrer, feeBpsOverride, floorMultiplier);
        address tokenIn = routes[0].from;
        // The fee's UNIT must be trustworthy, not just its rate. Once fee tokens
        // are configured, hop 0 must be one of them.
        if (feeTokenGateEnabled && !isFeeToken[tokenIn]) revert FeeTokenNotAllowed(tokenIn);
        _requireContract(tokenIn);

        // Everything downstream is sized from what ARRIVED, not what was asked
        // for. With a fee-on-transfer token those differ, and using the request
        // meant charging a fee on tokens the contract never received — which
        // either reverts or quietly spends someone else's stranded balance.
        // `received` is immediately reduced to the swappable remainder so this
        // frame keeps one local rather than three (the function is already at
        // the stack limit).
        uint256 received = _pullMeasured(tokenIn, msg.sender, amountIn);
        received -= _takeFee(tokenIn, received, referrer, feeBpsOverride, floorMultiplier);

        _approve(tokenIn, address(router), received);
        return _routeSwap(received, amountOutMin, routes, deadline);
    }

    /// @dev Split out purely to keep `_swap` under the stack limit.
    function _routeSwap(uint256 amountIn, uint256 amountOutMin, Route[] calldata routes, uint256 deadline)
        private
        returns (uint256)
    {
        uint256[] memory amounts =
            router.swapExactTokensForTokens(amountIn, amountOutMin, routes, msg.sender, deadline);
        return amounts[amounts.length - 1];
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
    function _checkFloor(address referrer, uint16 feeBpsOverride, uint16 floorMultiplier)
        private
        view
    {
        if (feeBpsOverride == 0) return; // 0 => the contract picks the rate
        uint256 rawFloor = uint256(_baseBps(referrer)) * floorMultiplier;
        uint16 floorBps = rawFloor > MAX_OVERRIDE_BPS ? MAX_OVERRIDE_BPS : uint16(rawFloor);
        // The CEILING is the configured rate for this leg, not the bare
        // constant. Bounding only by MAX_OVERRIDE_BPS decoupled the two: with
        // feeBps lowered to 50 the ceiling stayed 200, so a caller could still
        // charge 4x the configured rate and governance over MAX_FEE_BPS was
        // cosmetic. The override exists to let a zap leg pay 2x on the half it
        // swaps — it is not a licence to exceed the rate the owner set.
        if (feeBpsOverride > _ceilingBps(referrer, floorMultiplier) || feeBpsOverride < floorBps) {
            revert FeeTooHigh();
        }
    }

    /// @dev The most ANY leg may charge: the configured rate times the largest
    ///      legitimate leg multiplier, and never above the absolute constant.
    ///
    ///      The ceiling deliberately does NOT depend on which entrypoint was
    ///      called. Scaling it by this call's own `floorMultiplier` collapsed
    ///      `swapWithFee`'s band to the single point [feeBps, feeBps], which
    ///      broke the legacy zap path: when the DEPLOYED router lacks
    ///      `zapLegWithFee`, src/surfaces/zap.ts falls back to `swapWithFee`
    ///      carrying an explicit 2x override — a legitimate zap leg — and that
    ///      then reverted FeeTooHigh *after* both approvals had been mined,
    ///      stranding live allowances. That is the exact failure the zap surface
    ///      already carries a comment about having fixed once.
    ///
    ///      What the ceiling is really for is keeping governance over `feeBps`
    ///      meaningful: before, it was the bare MAX_OVERRIDE_BPS constant, so
    ///      lowering feeBps to 50 still let a caller charge 200 — 4x the
    ///      configured rate. Bounding at 2x the CONFIGURED rate keeps that
    ///      closed while leaving every honest leg representable.
    function _ceilingBps(address, uint16) private view returns (uint16) {
        uint256 raw = uint256(feeBps) * MAX_LEG_MULTIPLIER;
        return raw > MAX_OVERRIDE_BPS ? MAX_OVERRIDE_BPS : uint16(raw);
    }

    function _baseBps(address referrer) private view returns (uint16) {
        return (_referralActive(referrer) && referredFeeBps != 0) ? referredFeeBps : feeBps;
    }

    /// @dev A referral is only real when the referrer is owner-attested, is not
    ///      the caller, and an actual share is being paid. The discounted FLOOR
    ///      and the PAYOUT must agree on this — gating them on different
    ///      conditions let callers take the discount while paying no referrer.
    function _referralActive(address referrer) private view returns (bool) {
        // `maxReferralShareBps != 0` implements the third condition the comment
        // above has always claimed. Without it, a share of 0 — a legal config
        // the setters accept — still unlocked the DISCOUNT while paying the
        // referrer nothing: the operator forfeited the discount margin on every
        // bound trader and received no referral in exchange. The discount and
        // the payout now stand or fall together, which is what "must agree on
        // this" means.
        return referrer != address(0) && referrer != msg.sender && maxReferralShareBps != 0
            && referrerOf[msg.sender] == referrer;
    }

    /// @dev Split the fee between referrer (clamped share) and the operator.
    function _takeFee(
        address tokenIn,
        uint256 amountIn,
        address referrer,
        uint16 bpsOverride,
        uint16 floorMultiplier
    ) private returns (uint256 fee)
    {
        address paidReferrer;
        // Same base as the floor: an attested referral is CHARGED the discount
        // even when the caller passes no override.
        // The leg kind must drive the CHARGED rate, not just the floor. It used
        // to reach _checkFloor only, which returns early on bpsOverride == 0 -
        // so passing 0 (the value the bot itself passes, and the documented
        // "let the contract decide") charged a zap leg the plain 1x rate: a 50%
        // under-collection through the very entrypoint added to stop it (audit).
        uint256 scaled = uint256(_baseBps(referrer)) * floorMultiplier;
        uint16 base = scaled > MAX_OVERRIDE_BPS ? MAX_OVERRIDE_BPS : uint16(scaled);
        fee = (amountIn * (bpsOverride > 0 ? bpsOverride : base)) / BPS;
        uint256 referrerShare = 0;
        if (fee > 0) {
            // Self-referral is rejected: `referrer` is unauthenticated calldata,
            // so without this any caller could name THEMSELVES and rebate
            // maxReferralShareBps of their own fee — a permanent discount to
            // anyone who reads the ABI (audit finding). Referrals are a growth
            // incentive for bringing OTHER traders, never a self-discount.
            if (_referralActive(referrer)) {
                // The rate is OWNER state, never the trader's calldata. Reading
                // it from the caller let the referred trader keep the full
                // discount while paying their referrer 1 bps of the fee -
                // 99.97% of the commission destroyed by the very person the
                // referrer brought in (audit).
                referrerShare = (fee * maxReferralShareBps) / BPS;
                if (referrerShare > 0) {
                    _push(tokenIn, referrer, referrerShare);
                    paidReferrer = referrer;
                }
            }
            uint256 operatorShare = fee - referrerShare;
            if (operatorShare > 0) _push(tokenIn, feeRecipient, operatorShare);
        }
        // Emit the referrer ONLY when they were actually paid. On a small trade
        // the share truncates to zero, and indexing the address anyway produced
        // an event stream in which a referrer appeared to earn on trades that
        // paid them nothing — an off-chain indexer summing those over-reports
        // liabilities that were never incurred.
        emit SwappedWithFee(msg.sender, tokenIn, amountIn, fee, paidReferrer, referrerShare);
    }

    // ── Owner controls ────────────────────────────────────────────────────────

    function setConfig(address feeRecipient_, uint16 feeBps_, uint16 maxReferralShareBps_) external onlyOwner {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS || maxReferralShareBps_ > MAX_REFERRAL_SHARE_BPS) revert FeeTooHigh();
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
        } else {
            // Clamp the EFFECTIVE rate, never the pin. Overwriting the pin made
            // a temporary promo (100 -> 40 -> 100) latch the discount at 40
            // forever - the exact defect the branch above documents as fixed
            // (audit: I reintroduced it on the pinned path).
            uint16 effective = pinnedReferredFeeBps > feeBps_ ? feeBps_ : pinnedReferredFeeBps;
            if (effective != referredFeeBps) {
                referredFeeBps = effective;
                emit ReferredFeeBpsChanged(effective);
            }
        }
        maxReferralShareBps = maxReferralShareBps_;
        emit ConfigChanged(feeRecipient_, feeBps_, maxReferralShareBps_);
    }

    /// @notice Set the discounted rate referred traders pay (<= feeBps; 0 disables).
    function setReferredFeeBps(uint16 bps) external onlyOwner {
        if (bps > feeBps) revert FeeTooHigh();
        referredFeeBps = bps;
        pinnedReferredFeeBps = bps;
        referredFeeBpsPinned = true; // setConfig must stop re-deriving over this
        emit ReferredFeeBpsChanged(bps);
    }

    /// @notice Attest (or revoke) referrers in bulk. Only these unlock the
    ///         discounted rate and the referral payout.
    /// @notice Bind traders to the referrer that actually referred them.
    /// @dev Must be called before a referred trade or the trade pays full price
    ///      and the referrer is paid nothing. Nothing in the bot writes this
    ///      automatically: run scripts/bindreferrers.ts after signups. The bot
    ///      fails CLOSED meanwhile (src/core/referral.ts reads referrerOf before
    ///      quoting a discount), so drift costs referrers their commission but
    ///      never misprices a trade.
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
                if (allowed) { feeTokenCount++; feeTokenGateEnabled = true; }
                else feeTokenCount--;
            }
            emit FeeTokenSet(tokens[i], allowed);
        }
    }

    /// @notice Begin an ownership transfer. The new owner must ACCEPT it.
    /// @dev Two steps, because the one-step version handed ownership to whatever
    ///      address was typed: a wrong one permanently forfeited `rescue`, the
    ///      fee configuration and the referrer registry, with no way back. The
    ///      zero-address guard caught only the single most obvious typo.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept a pending ownership transfer. Only the named successor.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnerChanged(owner);
    }

    /// @notice Abandon a pending transfer.
    function cancelOwnershipTransfer() external onlyOwner {
        pendingOwner = address(0);
        emit OwnershipTransferStarted(owner, address(0));
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

    /// @dev Pull `amount` and return what ACTUALLY ARRIVED.
    ///      A fee-on-transfer or rebasing token delivers less than `amount`, and
    ///      this used to assume the request equalled the receipt. Every number
    ///      downstream — the fee, the referrer's cut, the amount handed to the
    ///      router — was then computed against tokens the contract did not hold,
    ///      so it either reverted or, worse, spent a THIRD PARTY's balance that
    ///      happened to be sitting here. Measuring the delta is the only honest
    ///      answer and costs two balance reads.
    function _pullMeasured(address token, address from, uint256 amount) private returns (uint256) {
        uint256 before = _balanceOf(token, address(this));
        _pull(token, from, amount);
        uint256 arrived = _balanceOf(token, address(this)) - before;
        return arrived < amount ? arrived : amount;
    }

    function _balanceOf(address token, address who) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, who)); // balanceOf
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
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

    /// @dev Set an allowance, tolerating tokens that refuse a non-zero->non-zero
    ///      change (USDT-style). Writing the absolute value alone reverted
    ///      permanently for such a token once any dust allowance was left
    ///      behind, bricking it for this router with no way to clear it.
    function _approve(address token, address spender, uint256 amount) private {
        if (!_tryApprove(token, spender, amount)) {
            // Reset to zero first, then retry. If the reset itself fails there
            // is nothing further to try and the revert is correct.
            if (!_tryApprove(token, spender, 0)) revert TransferFailed();
            if (!_tryApprove(token, spender, amount)) revert TransferFailed();
        }
    }

    function _tryApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount)); // approve
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}

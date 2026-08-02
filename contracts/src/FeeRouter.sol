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

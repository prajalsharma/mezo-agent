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
    uint16 public constant MAX_FEE_BPS = 100; // 1%
    uint16 public constant BPS = 10_000;

    IVeloRouter public immutable router;
    address public owner;
    address public feeRecipient;
    uint16 public feeBps;
    /// @dev Max share of the fee (in bps of the fee) a referrer may receive.
    uint16 public maxReferralShareBps;

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

    error NotOwner();
    error Reentered();
    error FeeTooHigh();
    error ZeroAddress();
    error EmptyRoute();
    error TransferFailed();

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
        maxReferralShareBps = maxReferralShareBps_;
    }

    /**
     * Pull `amountIn` of routes[0].from from the caller, keep the fee (split
     * with `referrer` when provided), swap the remainder via the Mezo Router,
     * and deliver the output DIRECTLY to the caller. Reverts as a unit.
     *
     * @param referralShareBps referrer's share of the fee, in bps of the fee;
     *        clamped to `maxReferralShareBps`. Ignored when referrer is zero.
     */
    function swapWithFee(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        uint256 deadline,
        address referrer,
        uint16 referralShareBps
    ) external nonReentrant returns (uint256 amountOut) {
        if (routes.length == 0) revert EmptyRoute();
        address tokenIn = routes[0].from;

        _pull(tokenIn, msg.sender, amountIn);
        uint256 fee = _takeFee(tokenIn, amountIn, referrer, referralShareBps);

        _approve(tokenIn, address(router), amountIn - fee);
        uint256[] memory amounts =
            router.swapExactTokensForTokens(amountIn - fee, amountOutMin, routes, msg.sender, deadline);
        amountOut = amounts[amounts.length - 1];
    }

    /// @dev Split the fee between referrer (clamped share) and the operator.
    function _takeFee(address tokenIn, uint256 amountIn, address referrer, uint16 referralShareBps)
        private
        returns (uint256 fee)
    {
        fee = (amountIn * feeBps) / BPS;
        uint256 referrerShare = 0;
        if (fee > 0) {
            if (referrer != address(0) && referralShareBps > 0) {
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
        maxReferralShareBps = maxReferralShareBps_;
        emit ConfigChanged(feeRecipient_, feeBps_, maxReferralShareBps_);
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

import { b, i } from "./format.js";

/**
 * Static ELI5 explainers, invoked by concept keyword (HeyAnon's pattern: every
 * protocol ships a jargon-free explainer the agent can serve VERBATIM). Hand-
 * written — the LLM never generates or paraphrases these, so education carries
 * zero hallucination surface. Each ends with the concrete next message(s), in
 * quotes so GUIDE-mode's suggestion buttons pick them up too.
 */
type Explainer = { match: RegExp; title: string; body: string };

const EXPLAINERS: Explainer[] = [
  {
    match: /liquidat/i,
    title: "💥 Liquidation, simply",
    body:
      "When you borrow MUSD, your BTC is the guarantee (collateral). The rule: your BTC must stay worth at least 110% of your debt.\n\n" +
      "If BTC's price falls far enough that your collateral is worth less than that, ANYONE can close your position and you lose the BTC — that's liquidation.\n\n" +
      "Your confirmation card always shows your live ratio and the BTC price where liquidation would happen. Staying above ~150% gives you a comfortable buffer.\n\n" +
      'Check yours: "portfolio" · make it safer: "add 0.01 BTC collateral" or "repay 200 MUSD"',
  },
  {
    match: /collateral\s*ratio|\bicr\b|\bmcr\b/i,
    title: "🧮 Collateral ratio, simply",
    body:
      "Collateral ratio = value of your locked BTC ÷ your MUSD debt.\n\n" +
      "200% means your BTC is worth twice your debt (comfortable). 110% is the minimum the protocol allows — below that you can be liquidated.\n\n" +
      'See your ratio before every borrow, and live via "portfolio".',
  },
  {
    match: /impermanent\s*loss|\bIL\b/,
    title: "🌊 Impermanent loss, simply",
    body:
      "When you provide two tokens to a pool, the pool constantly rebalances them. If one token's price moves a lot versus the other, you end up with more of the weaker one — so your LP can be worth less than if you'd just held both tokens.\n\n" +
      "It's called 'impermanent' because it shrinks if prices come back together. Trading fees and rewards are what compensate you for taking this risk.\n\n" +
      "Stable-stable pools (like MUSD/mUSDC) have almost none of it; BTC/MUSD has more.",
  },
  {
    match: /epoch|bribe/i,
    title: "📅 Epochs & bribes, simply",
    body:
      "Mezo's rewards run in weekly rounds called epochs (they flip every Thursday 00:00 UTC).\n\n" +
      "Each epoch, veNFT holders vote on which pools get rewards. Projects add extra incentives ('bribes') to attract votes. Voters earn a share of fees + bribes from the pools they voted for.\n\n" +
      "Votes persist between epochs, but re-voting each week captures the freshest incentives.\n\n" +
      'Try: "vote optimally with veNFT 1" — it splits your vote to maximize expected earnings from live data.',
  },
  {
    match: /venft|ve-?btc|ve-?mezo|lock decay|voting power/i,
    title: "🔒 veNFTs, simply",
    body:
      "Lock BTC (1–28 days) or MEZO (up to 4 years) and you get a veNFT — a position NFT that carries voting power.\n\n" +
      "Longer lock = more power. Power decays as expiry approaches. You CANNOT unlock early — the tokens are committed until the lock ends.\n\n" +
      "With a veNFT you vote weekly on pool rewards and earn fees + bribes for it.\n\n" +
      'Try: "lock 0.01 BTC for 28 days" · then "vote optimally"',
  },
  {
    match: /slippage/i,
    title: "📉 Slippage, simply",
    body:
      "Between your quote and the moment your swap lands, the pool price can move. Slippage tolerance is the worst deal you're willing to accept.\n\n" +
      "This bot defaults to 0.5%: the confirmation card shows a 'Min received' — if the pool can't give you at least that, the swap cancels itself instead of filling badly. Nothing is lost on a cancelled swap.",
  },
  {
    match: /\bzap\b|zapping/i,
    title: "⚡ Zap, simply",
    body:
      "Entering a pool normally takes 4 steps: swap half your asset, approve both tokens, deposit them in ratio, stake the LP. A zap does the whole chain from one asset in one flow.\n\n" +
      "You give one token; the bot swaps half, pairs them, and deposits. You end up earning pool rewards without touching the mechanics.\n\n" +
      'Try: "zap 0.01 BTC into BTC/MUSD"',
  },
  {
    match: /rebase/i,
    title: "🔁 Rebases, simply",
    body:
      "veNFT holders receive periodic rebase rewards — extra locked tokens that offset dilution from emissions. They accumulate whether you do anything or not, but they sit UNCLAIMED until you collect them.\n\n" +
      "Most holders never claim. Claiming here is free of agent fees.\n\n" +
      'Try: "claim all" — it sweeps rebases, voting rewards and pool earnings in one flow.',
  },
];

/** Return the explainer for a "what is X / explain X" style question, if any. */
export function explainerFor(text: string): string | undefined {
  const asking = /\bwhat(?:'s| is| are)\b|\bexplain\b|\beli5\b|\bmean[s]?\b|\bhow do(?:es)?\b.*\bwork/i.test(text);
  if (!asking) return undefined;
  const hit = EXPLAINERS.find((e) => e.match.test(text));
  if (!hit) return undefined;
  return `${b(hit.title)}\n\n${hit.body}\n\n${i("Hand-written explainer — not generated. Ask anything else, or /help.")}`;
}

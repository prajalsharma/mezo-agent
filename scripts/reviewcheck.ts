export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * Is each finding from the correctness & security review ACTUALLY closed?
 *
 * Every check below looks for the defect's own signature in the current source
 * — the specific line, call, or absence the review named — rather than trusting
 * that a commit message says it was fixed. A check that goes green because the
 * code was deleted and not replaced is worse than no check, so wherever it
 * matters the assertion is "the FIX is present", not merely "the defect string
 * is gone".
 *
 *   npx tsx scripts/reviewcheck.ts
 */
import { readFileSync, existsSync } from "node:fs";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

let pass = 0;
const open: string[] = [];
const partial: string[] = [];

function check(id: string, title: string, ok: boolean, note = "") {
  if (ok) { pass++; console.log(`  ✓ ${id.padEnd(4)} ${title}`); }
  else { open.push(`${id} ${title}${note ? ` — ${note}` : ""}`); console.log(`  ✗ ${id.padEnd(4)} ${title}   ${note}`); }
}
function known(id: string, title: string, why: string) {
  partial.push(`${id} ${title} — ${why}`);
  console.log(`  ◐ ${id.padEnd(4)} ${title}   (${why})`);
}

const borrow = read("src/surfaces/borrow.ts");
const params = read("src/core/musdParams.ts");
const prices = read("src/core/prices.ts");
const abis = read("src/abis/mezo.ts");
const session = read("src/bot/session.ts");
const signer = read("src/custody/signer.ts");
const policy = read("src/custody/policy.ts");
const sched = read("src/keeper/scheduler.ts");
const alerts = read("src/keeper/alerts.ts");
const store = read("src/db/store.ts");
const intent = read("src/llm/intent.ts");
const adapter = read("src/llm/adapter.ts");
const zap = read("src/surfaces/zap.ts");
const swapB = read("src/surfaces/swap/swapBuilder.ts");
const plan = read("src/surfaces/plan.ts");
const vote = read("src/surfaces/vote.ts");
const lock = read("src/surfaces/lock.ts");
const misc = read("src/surfaces/misc.ts");
const earn = read("src/surfaces/earn.ts");
const feed = read("src/core/incentivesFeed.ts");
const optvote = read("src/core/optimalVoting.ts");
const bot = read("src/bot/bot.ts");
const menu = read("src/bot/menu.ts");
const menuH = read("src/bot/handlers/menu.ts");
const onboard = read("src/bot/handlers/onboarding.ts");
const limits = read("src/bot/handlers/limits.ts");
const actions = read("src/bot/handlers/actions.ts");
const swapH = read("src/bot/handlers/swap.ts");
const autom = read("src/bot/handlers/automation.ts");
const portfolio = read("src/portfolio/portfolioService.ts");
const log = read("src/core/log.ts");
const verifyaddrs = read("scripts/verifyaddrs.ts");
const dockerfile = read("Dockerfile");
const gitignore = read(".gitignore");
const feeRouter = read("contracts/src/FeeRouter.sol");
const delegate = read("contracts/src/SessionKeyDelegate.sol");
const auditmd = read("AUDIT.md");
const audit2md = read("AUDIT2.md");

console.log("\nCRITICAL\n");
check("C1", "gas compensation is in the composite debt",
  params.includes("gasCompensation") && /compositeDebt[\s\S]{0,300}p\.gasCompensation/.test(params)
    && borrow.includes("compositeDebt(") && !/mintMUSD \* 0\.01/.test(borrow));
check("C2", "maxBorrowingCapacity is read and bounds mints",
  params.includes("getTroveMaxBorrowingCapacity") && borrow.includes("maxBorrowingCapacity(owner)"));
check("C3", "confirm buttons carry a single-use plan id",
  session.includes("takePending") && /p\.id !== id/.test(session)
    && swapH.includes("`swap:confirm:${planId}`") && actions.includes("action:confirm:${planId}"));
check("C4", "signer independently vets the target against the registry",
  signer.includes("isVettedTarget") && signer.includes("registry.knownAddresses()"));
check("C5", "phantom lastGoodPrice is gone; probe AND display use fetchPrice",
  !/name: "lastGoodPrice"/.test(abis) && verifyaddrs.includes('name: "fetchPrice"')
    && !/resolved\["PriceFeed\.lastGoodPrice"\]/.test(verifyaddrs));
check("C6", "everyHours=0 refused at creation AND by the parser",
  /everyHours < MIN_INTERVAL_HOURS/.test(sched) && /Intent\.safeParse\(rule\)/.test(adapter));
check("C7", "keeper has an in-flight guard and claims the slot first",
  sched.includes("let ticking = false") && /store\.updateSchedule\([\s\S]{0,200}nextRunAt[\s\S]{0,400}await executor/.test(sched));
const atomicSwapStep = swapB.slice(swapB.indexOf('functionName: "swapWithFee"'));
check("C8", "the atomic swap waits for its receipt",
  atomicSwapStep.slice(0, atomicSwapStep.indexOf("});")).includes("waitForReceipt: true"));
check("C9", "vote coverage is measured and 'optimal' is conditional",
  feed.includes("voterCoverage") && vote.includes("wellCovered") && vote.includes('"Best available"'));

console.log("\nHIGH\n");
check("H1", "borrowing rate is read live, not hardcoded",
  params.includes('read("borrowingRate")') && !/\* 1\.01/.test(borrow));
check("H2", "a stale/unreadable price BLOCKS instead of skipping",
  borrow.includes("marketOrRefuse") && /price feed is stale or unreadable/i.test(borrow));
check("H3", "veNFT transfer is priced so caps and step-up apply",
  misc.includes("lockedAmountOf") && /erc20: \{ symbol: asset, amount: lockedWei/.test(misc));
const zapSwapLeg = zap.slice(zap.indexOf('kind: "swap", to: swapLegTarget'));
const zapAddLiq = zap.slice(zap.indexOf('kind: "addLiquidity"'));
check("H4", "every zap leg carries a value descriptor",
  zapSwapLeg.slice(0, zapSwapLeg.indexOf("},\n    {")).includes('erc20: { symbol: inSym, amount: half, kind: "spend" }')
    && zapAddLiq.slice(0, 2000).includes('erc20: { symbol: inSym, amount: half, kind: "spend" }'));
check("H5", "callback-built intents go through the Zod schema",
  intent.includes("export function validateIntent") && actions.includes("validateIntent(raw)") && swapH.includes("validateIntent(raw)"));
check("H6", "secret guard is middleware over every text-bearing update",
  /ctx\.editedMessage\?\.text/.test(bot) && /ctx\.message\?\.caption/.test(bot));
check("H7", "/export needs a fresh single-use token",
  onboard.includes("armExport") && onboard.includes("takeExport") && !/auto-deletes in 60s/.test(onboard));
// Asserts the PROPERTY, not one spelling of it: the write is atomic (temp +
// fsync + rename), a backup exists, and an I/O failure is distinguished from a
// parse failure so an unreadable-but-intact file is never overwritten. The
// follow-up round moved the write into writeAtomic(), which is why matching the
// old literal broke while every guarantee still held.
check("H8", "store writes atomically with a backup and a guarded load",
  /writeAtomic\(path: string, body: string\)[\s\S]{0,500}fsyncSync[\s\S]{0,200}renameSync\(tmp, path\)/.test(store)
    && store.includes("this.writeAtomic(this.path, body)")
    && store.includes("this.writeAtomic(this.bakPath, body)")
    && store.includes("store.unreadable"));
check("H9", "Recovery Mode / CCR is modelled",
  params.includes("recoveryMode") && params.includes("ccr") && borrow.includes("inRecovery"));
check("H10", "redemption ranking is disclosed and claimCollateral exists",
  borrow.includes("REDEMPTION_NOTE") && borrow.includes("buildClaimCollateral") && intent.includes("ClaimCollateralIntent"));
check("H11", "slippage is clamped well below 50%",
  /MAX_SLIPPAGE_PCT = 5\b/.test(intent) && intent.includes("max(MAX_SLIPPAGE_PCT)"));
// The invariant is "it cannot alert unboundedly", NOT the particular way that
// was first achieved. Clearing troveAt fixed the original 30-minute loop but
// removed the rate floor entirely; the floor is now explicit and survives a
// recovery, which is the durable form of the same guarantee.
check("H12", "the trove alert cannot repeat unboundedly",
  alerts.includes("MIN_REALERT_MS") && /const rateOk = [\s\S]{0,120}MIN_REALERT_MS/.test(alerts)
    && /if \(!rateOk\) return;/.test(alerts));
check("H13", "increaseUnlockTime is sent a duration from now",
  lock.includes("lockEnd(") && /const duration = target - nowSec/.test(lock));
check("H14", "zap addLiquidity is re-sized from the live balance",
  plan.includes("rebuild?:") && zap.includes("rebuild: async (who)") && /balanceOf.*who/.test(zap));

console.log("\nMEDIUM\n");
check("M1", "cap-raise confirmation has a TTL and an id", limits.includes('kind: "limits-raise"') && session.includes("RAISE_TTL_MS"));
check("M2", "repay uses the NET debt basis", /netDebt = trove\.debt > p\.gasCompensation/.test(borrow));
check("M3", "closeTrove needs debt minus gas compensation", borrow.includes("owedByBorrower"));
known("M4", "refinance still not implemented", "documented; adjust now says the cap cannot be raised by adding collateral");
check("M5", "trove status distinguishes liquidated/redeemed", borrow.includes("assertHasTrove") && borrow.includes('"liquidated"'));
check("M6", "account switch between render and confirm is caught",
  session.includes("accountAddress") && swapH.includes("You switched active account"));
check("M7", "an ERC-20 24h aggregate cap exists",
  policy.includes("dailyTokenCapOf") && signer.includes("spentLast24hToken"));
check("M8", "operator tier exists and reaches the kill-switch",
  bot.includes('bot.command("keeper"') && bot.includes("isOperator"));
check("M9", "the on-chain deadline matches the quote TTL",
  /DEADLINE_SECONDS = 5 \* 60/.test(swapB) && /Date\.now\(\) \/ 1000\) \+ 5 \* 60/.test(zap));
check("M10", "liquidation consequences are stated accurately",
  /liquidator keeps a cut/.test(alerts) && /gas compensation/.test(borrow));
// The ceiling must derive from the CONFIGURED rate, never the bare constant —
// otherwise lowering feeBps leaves what a caller may charge unchanged. (The
// follow-up round restored the parameters so the referred band cannot collapse;
// both properties are asserted together.)
check("M11", "the override ceiling tracks the configured rate",
  feeRouter.includes("MAX_LEG_MULTIPLIER")
    && /function _ceilingBps\(address referrer, uint16 floorMultiplier\)/.test(feeRouter)
    && /uint256\(feeBps > base \? feeBps : base\) \* MAX_LEG_MULTIPLIER/.test(feeRouter));
check("M12", "referral share is bounded and ownership transfer is two-step",
  feeRouter.includes("MAX_REFERRAL_SHARE_BPS") && feeRouter.includes("acceptOwnership"));
check("M13", "fee-on-transfer inputs are sized from what arrived",
  feeRouter.includes("_pullMeasured") && feeRouter.includes("_tryApprove")
    && read("contracts/test/FeeRouter.t.sol").includes("FeeOnTransferERC20"));
check("M14", "cadence anchors on the schedule; timers stop on shutdown",
  sched.includes("export function nextSlot") && read("src/index.ts").includes("stopKeeper()") && alerts.includes("export function stopAlerts"));
check("M15", "an unreadable balance is not reported as 'no balance'",
  portfolio.includes("unreadable") && menu.includes("Couldn't read your balances"));
check("M16", "auto-compound no longer claims to run", /Not yet automatic/.test(autom));
check("M17", "unknown reward-token decimals count as unpriced",
  /async function tokenDecimals/.test(feed) && /if \(dec === undefined\) \{ unpriced\.push/.test(feed));
check("M18", "an unresolvable pool refuses instead of shrinking the vote",
  /weights would no longer/.test(vote) && /totalBps !== 10_000n/.test(vote));
check("M19", "zap honours the user's slippage", zap.includes("intent.slippagePct ?? 0.5"));
check("M20", "uncontested gauges get the floor, and hi cannot be Infinity",
  optvote.includes("MIN_BPS") && !optvote.includes("/ 1e-12"));
check("M21", "the spend ledger is pruned", store.includes("pruneSpendLedger"));

console.log("\nLOW\n");
check("L1", "container does not run as root", dockerfile.includes("docker-entrypoint.sh") && read("docker-entrypoint.sh").includes("APP_USER"));
check("L2", "lockfile is committed and the image uses npm ci",
  !/^package-lock\.json$/m.test(gitignore) && dockerfile.includes("npm ci") && existsSync("package-lock.json"));
check("L3", "error text is redacted before log and chat",
  log.includes("export function redact") && bot.includes("redact(message)"));
check("L4", "per-user caches are bounded", bot.includes("MAX_CACHED_USERS"));
known("L5", "8-dec tokens still use the 18-dec fallback cap", "latent; those tokens have no pool on Mezo");
check("L6", "alert divides safely; /limits escapes; referrer event is honest",
  /trove\.collBTC <= 0/.test(alerts) && limits.includes("esc(fmtBtc(current))") && feeRouter.includes("paidReferrer"));

console.log("\nFALSE COMMENTS (§9)\n");
check("§9a", "AUDIT.md / AUDIT2.md are marked superseded",
  auditmd.includes("SUPERSEDED") && audit2md.includes("SUPERSEDED") && existsSync("SECURITY.md"));
check("§9b", "the hint comment no longer claims a refresh that never happens",
  !/fetched FRESH/.test(borrow) && /getApproxHint is never called/.test(borrow));
check("§9c", "the registry no longer claims lastGoodPrice verification",
  !read("src/registry/addresses.ts").includes("lastGoodPrice"));
check("§9d", "the scheduler's idempotency comment matches the code",
  /CLAIMED \(nextRunAt advanced\) before/.test(sched));
check("§9e", "vote.ts's ownership check actually exists",
  vote.includes("assertVotable") && vote.includes('functionName: "ownerOf"'));
check("§9f", "the delegate header does not claim the fee-override bound holds",
  !/cannot burn up to MAX_OVERRIDE_BPS of the account's principal per swap\./.test(delegate)
    && /open item 7/.test(delegate));

console.log("\n" + "─".repeat(66));
console.log(`closed & verified : ${pass}`);
console.log(`known-open        : ${partial.length}`);
console.log(`STILL OPEN        : ${open.length}`);
if (partial.length) { console.log("\nKnown-open (documented, not silently dropped):"); for (const p of partial) console.log(`  ◐ ${p}`); }
if (open.length) { console.log("\nSTILL OPEN:"); for (const o of open) console.log(`  ✗ ${o}`); }
console.log(open.length === 0 ? "\nEvery review finding is closed or explicitly documented. ✅" : `\n${open.length} FINDING(S) NOT CLOSED ✗`);
process.exit(open.length === 0 ? 0 : 1);

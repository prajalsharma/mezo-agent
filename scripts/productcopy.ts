export {};
import "./_testenv.js"; // MUST be first: seeds env before config/env.js evaluates
/**
 * On MAINNET the bot is a real product handling real BTC, so no user-facing
 * string may call it a test, offer a faucet, or point at a test network.
 *
 * The network badge itself is deliberately NOT banned: the bounty requires a
 * clear Testnet-vs-Mainnet indicator, and on mainnet that badge reads
 * "🟢 Mainnet", which is exactly right. What this catches is copy that assumes
 * testnet regardless of where it runs.
 *
 *   MEZO_NETWORK=mainnet npx tsx scripts/productcopy.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Words that must never reach a mainnet user. */
const BANNED = [
  /\btestnet\b/i,
  /\btest\s+BTC\b/i,
  /faucet/i,
  /\bthrowaway\b/i,
  /faucet\.test\.mezo\.org/i,
];

/** Only user-facing surfaces; the keeper and contracts are not chat copy. */
const ROOTS = ["src/bot", "src/surfaces", "src/keeper"];

/**
 * The single module permitted to hold test-network copy. Every export there
 * returns undefined on mainnet, so the strings cannot render in the live
 * product - that is the whole point of concentrating them.
 */
const ALLOWED = "src/bot/faucet.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Strip comments and any line already gated on a non-mainnet check, so a
 * correctly-gated faucet button is not reported. This is a lint over source
 * text, so it is deliberately conservative: it can miss a multi-line gate, and
 * that is preferable to failing on correct code.
 */
function offending(file: string): Array<{ line: number; text: string }> {
  if (file.replace(/\\/g, "/").endsWith(ALLOWED)) return [];
  const src = readFileSync(file, "utf8").split("\n");
  const hits: Array<{ line: number; text: string }> = [];
  src.forEach((raw, idx) => {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return;
    // A line that BRANCHES on the network is the correct pattern, not a bug:
    // the Testnet badge is a bounty requirement and reads "Mainnet" when live.
    if (/network\s*[!=]==?\s*"mainnet"/.test(line)) return;
    // Only STRING LITERALS are user-facing. An identifier like faucetButton()
    // is a call into the gated module, not copy, and flagging it would push
    // people to name things badly to satisfy the linter.
    const literals = [...line.matchAll(/"([^"\\\\]*)"|'([^'\\\\]*)'|`([^`]*)`/g)]
      // Drop ${...} interpolation: a call into the gated module is not copy.
      .map((m) => (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, ""));
    for (const lit of literals) {
      if (lit.endsWith(".js") || lit.endsWith(".ts")) continue; // import paths
      if (BANNED.some((re) => re.test(lit))) hits.push({ line: idx + 1, text: lit.slice(0, 110) });
    }
  });
  return hits;
}

let fail = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    for (const h of offending(file)) {
      console.log(`  ✗ ${file}:${h.line}  ${h.text}`);
      fail++;
    }
  }
}

console.log(
  fail === 0
    ? "\nProduct copy OK - nothing assumes testnet. ✅"
    : `\n${fail} string(s) assume testnet and would ship to mainnet users ✗`,
);
process.exit(fail === 0 ? 0 : 1);

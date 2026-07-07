import { Pipeline } from "./core/pipeline.js";
import { signer } from "./signer/signer.js";

/**
 * Offline driver for the full intent → confirm pipeline, no Telegram token
 * required. Runs a batch of representative messages through the deterministic
 * core and prints what the user would see, then simulates the confirm/sign step.
 */

const MESSAGES = [
  "show my portfolio",
  "borrow with 0.1 BTC, mint 5000 MUSD",
  "borrow with 0.1 BTC and mint 500 MUSD", // below min net debt -> clarify
  "swap 0.05 BTC to MUSD",
  "zap 800 BTC into MUSD/MUSDC", // exceeds BTC cap -> blocked
  "zap 0.1 BTC into MUSD/MUSDC",
  "lock 0.2 BTC for 28 days",
  "lock 1000 MEZO for 2 years",
  "vote optimally",
  "claim everything",
  "enter the pool with some BTC", // ambiguous -> clarify
  "do something clever", // unsupported
];

async function main(): Promise<void> {
  const pipeline = new Pipeline();
  const userId = "demo-user";
  console.log(`Signer mode: ${signer.mode}\n${"=".repeat(60)}`);

  for (const msg of MESSAGES) {
    console.log(`\n👤 ${msg}`);
    const outcome = await pipeline.handle(userId, msg);
    switch (outcome.kind) {
      case "clarify":
        console.log(`🤔 ${outcome.message}`);
        break;
      case "unsupported":
        console.log(`🚫 ${outcome.message}`);
        break;
      case "blocked":
        console.log(`🛑 ${outcome.message}`);
        break;
      case "read":
        console.log(outcome.message);
        break;
      case "confirm": {
        console.log(outcome.summary);
        const res = await signer.signAndSubmit(userId, outcome.intent, outcome.plan);
        console.log(res.submitted ? `→ ✅ submitted ${res.txHash}` : `→ 🧪 ${res.reason}`);
        break;
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

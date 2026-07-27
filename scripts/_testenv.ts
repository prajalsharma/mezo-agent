/**
 * Test-environment stub. MUST be the first import in any offline script.
 *
 * Why a separate module: ESM hoists and evaluates every `import` before the
 * first statement of the module body, so a script that assigns
 * `process.env.TELEGRAM_BOT_TOKEN` at the top of its own body assigns it too
 * late — config/env.js has already been evaluated and thrown. Importing this
 * module first works because imports are evaluated in source order.
 *
 * These values are deliberately non-secret and non-functional: the token is not
 * a real Telegram token, and the encryption key exists only to exercise the
 * seal/use round-trip against a throwaway DATA_DIR.
 */
process.env.TELEGRAM_BOT_TOKEN ??= "dummy:token";
process.env.MASTER_ENCRYPTION_KEY ??=
  "799c6913b2793d2c08a783778788ddb06f090b2f93771f6bc6d247e3ac7d679b";
process.env.MEZO_NETWORK ??= "testnet";
process.env.ANTHROPIC_API_KEY = ""; // never call a real LLM from a check
process.env.TELEGRAM_ALLOWED_USER_IDS ??= "";

// Each script gets its own throwaway datastore, derived from the entry filename
// so no check can clobber another's state (or the user's real ./data). Set here
// rather than in the scripts themselves for the same hoisting reason as above.
const entry = process.argv[1]?.split("/").pop()?.replace(/\.[tj]s$/, "") ?? "check";
process.env.DATA_DIR ??= `./data-${entry}`;

export {};

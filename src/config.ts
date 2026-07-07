import "dotenv/config";

/**
 * Central, typed configuration. Read once at boot.
 *
 * Security note: secrets are read here but must never be logged, echoed to the
 * user, or passed to the LLM adapter. Only `config.chain` and `config.policy`
 * are safe to surface in confirmations.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.toLowerCase() === "true" || raw === "1";
}

export type LlmProvider = "fallback" | "anthropic" | "openai";

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",

  chain: {
    chainId: num("MEZO_CHAIN_ID", 31611),
    rpcUrl: process.env.MEZO_RPC_URL ?? "https://rpc.test.mezo.org",
    // BTC is the native gas asset on Mezo — reflected everywhere gas is discussed.
    nativeSymbol: "BTC",
  },

  llm: {
    provider: (process.env.LLM_PROVIDER ?? "fallback") as LlmProvider,
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
    openaiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "",
  },

  signer: {
    // Present only for the Tier-3 local-dev fallback. Empty => dry-run only.
    privateKey: process.env.SIGNER_PRIVATE_KEY ?? "",
  },

  policy: {
    maxBtcPerAction: num("POLICY_MAX_BTC_PER_ACTION", 0.25),
    maxMusdPerAction: num("POLICY_MAX_MUSD_PER_ACTION", 25_000),
    dailyBtcCap: num("POLICY_DAILY_BTC_CAP", 1.0),
    watchOnly: bool("POLICY_WATCH_ONLY", false),
  },
} as const;

export type AppConfig = typeof config;

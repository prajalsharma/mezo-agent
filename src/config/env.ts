import "dotenv/config";

/**
 * Central, validated environment access. Nothing else in the app reads
 * process.env directly — so misconfiguration fails fast and in one place.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}. See .env.example.`);
  }
  return v.trim();
}

function optional(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

export type NetworkName = "testnet" | "mainnet";

const network = optional("MEZO_NETWORK", "testnet") as NetworkName;
if (network !== "testnet" && network !== "mainnet") {
  throw new Error(`MEZO_NETWORK must be "testnet" or "mainnet", got "${network}"`);
}

export const env = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  network,

  /** AES-256-GCM master key (hex). Validated to 32 bytes in the keystore. */
  masterEncryptionKey: required("MASTER_ENCRYPTION_KEY"),

  llm: {
    provider: optional("LLM_PROVIDER", "anthropic"),
    anthropicApiKey: optional("ANTHROPIC_API_KEY"),
    anthropicModel: optional("ANTHROPIC_MODEL", "claude-sonnet-5"),
  },

  dataDir: optional("DATA_DIR", "./data"),
} as const;

/** True when the LLM parser is usable; otherwise the deterministic parser is used. */
export const llmEnabled = env.llm.provider === "anthropic" && env.llm.anthropicApiKey !== "";

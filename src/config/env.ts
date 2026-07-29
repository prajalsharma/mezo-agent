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

  /** Optional RPC override (else the per-network default in networks.ts is used). */
  rpcUrl: optional("MEZO_RPC_URL"),

  /**
   * Confirmed contract addresses supplied at runtime (not invented in code).
   * Setting the Router enables on-chain swap execution; setting the delegate
   * enables the EIP-7702 /upgrade flow. Empty => the feature stays gated.
   */
  contracts: {
    router: optional("MEZO_ROUTER_ADDRESS"),
    delegate7702: optional("DELEGATE7702_ADDRESS"),
  },

  /**
   * Generic per-contract overrides: MEZO_ADDR_<ContractKey>, e.g.
   *   MEZO_ADDR_BORROWEROPERATIONS=0x...
   *   MEZO_ADDR_VOTER=0x...
   *
   * Previously only Router and Delegate7702 had an override path, so every other
   * surface needed a code edit to activate — which made "confirm the address and
   * it turns on" true for two contracts and false for the other nine. Keys are
   * matched case-insensitively against ContractKey by the registry. Malformed
   * values are dropped here rather than reaching a signer.
   */
  contractOverrides: Object.entries(process.env)
    .filter(([k, v]) => k.startsWith("MEZO_ADDR_") && /^0x[0-9a-fA-F]{40}$/.test((v ?? "").trim()))
    .reduce<Record<string, string>>((acc, [k, v]) => {
      acc[k.slice("MEZO_ADDR_".length).toLowerCase()] = v!.trim();
      return acc;
    }, {}),

  /** AES-256-GCM master key (hex). Validated to 32 bytes in the keystore. */
  masterEncryptionKey: required("MASTER_ENCRYPTION_KEY"),

  llm: {
    provider: optional("LLM_PROVIDER", "anthropic"),
    anthropicApiKey: optional("ANTHROPIC_API_KEY"),
    anthropicModel: optional("ANTHROPIC_MODEL", "claude-sonnet-5"),
  },

  dataDir: optional("DATA_DIR", "./data"),

  /**
   * Comma-separated Telegram user IDs permitted to interact with the bot.
   * A Telegram bot is publicly reachable by username the moment it exists —
   * there is no "unlisted" mode — so this is the only thing standing between a
   * local dev run and a stranger driving a wallet-bearing agent. Empty => open
   * to everyone (startup warns loudly).
   */
  allowedUserIds: new Set(
    optional("TELEGRAM_ALLOWED_USER_IDS")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isSafeInteger(n) && n > 0),
  ),

  /** Keeper (DCA / auto-compound) global kill-switch. Off unless explicitly on. */
  keeperEnabled: optional("KEEPER_ENABLED", "false").toLowerCase() === "true",

  /**
   * Monetization. A small, transparently-disclosed fee on swaps/zaps executed
   * through the agent. Shown in EVERY pre-confirmation summary and via /fees —
   * never silent. Zero (or no recipient) => no fee is charged or displayed.
   * Capped at 100 bps (1%) in code so a misconfiguration can't overcharge users.
   */
  fees: {
    swapBps: Math.min(Number(optional("AGENT_FEE_BPS", "0")) || 0, 100),
    recipient: optional("AGENT_FEE_RECIPIENT"),
    /** Monthly price for automation (DCA / auto-compound), display-only. */
    automationNote: optional("AGENT_AUTOMATION_NOTE"),
    /** Referral revenue share (% of the agent fee), disclosed via /referral. */
    referralSharePct: Math.min(Math.max(Number(optional("AGENT_REFERRAL_SHARE_PCT", "30")) || 0, 0), 100),
  },
} as const;

/** True when a non-zero fee AND a recipient are configured. */
export const feesEnabled =
  env.fees.swapBps > 0 && /^0x[0-9a-fA-F]{40}$/.test(env.fees.recipient);

/** True when the bot is restricted to a fixed set of Telegram user IDs. */
export const accessRestricted = env.allowedUserIds.size > 0;

/** True when the LLM parser is usable; otherwise the deterministic parser is used. */
export const llmEnabled = env.llm.provider === "anthropic" && env.llm.anthropicApiKey !== "";

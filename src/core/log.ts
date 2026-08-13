/**
 * Tiny structured logger. Never logs secrets — callers pass only public fields
 * (addresses, step names, error messages). Errors are decoded to their message,
 * never their stack-with-locals.
 */
type Fields = Record<string, string | number | boolean | undefined>;

/**
 * Patterns that must never reach a log sink or a chat window.
 *
 * Callers pass public fields by convention, but ERROR TEXT is not written by us:
 * a viem or grammY exception routinely quotes the RPC URL it called (which can
 * carry an API key in the path or query) or echoes the calldata it was handed.
 * A convention that holds everywhere except the one place errors arrive is not a
 * convention that holds, so the redaction is applied mechanically instead.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // 64-hex private keys / seeds, with or without the 0x. Bounded by non-hex so a
  // 64-hex *transaction hash* is caught too — losing a hash in a log is cheap,
  // leaking a key is not.
  [/\b(0x)?[0-9a-fA-F]{64}\b/g, "«64-hex redacted»"],
  // Telegram bot tokens: <digits>:<35 base64url chars>.
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "«bot-token redacted»"],
  // Credentials or keys embedded in a URL.
  [/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1«credentials redacted»@"],
  [/([?&](?:api[_-]?key|key|token|secret|auth)=)[^&\s]+/gi, "$1«redacted»"],
  // BIP-39 mnemonics: 12+ consecutive lowercase words.
  [/\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g, "«mnemonic redacted»"],
];

/** Strip secret-shaped substrings from arbitrary text before it is emitted. */
export function redact(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

function fmt(level: string, event: string, fields?: Fields): string {
  const parts = [`[${level}]`, event];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) parts.push(`${k}=${redact(typeof v === "string" ? v : String(v))}`);
    }
  }
  return parts.join(" ");
}

export const log = {
  info: (event: string, fields?: Fields) => console.log(fmt("info", event, fields)),
  warn: (event: string, fields?: Fields) => console.warn(fmt("warn", event, fields)),
  error: (event: string, fields?: Fields) => console.error(fmt("error", event, fields)),
  /** Log a step in a traced flow, e.g. step("wallet:create", "seal", {user}). */
  step: (flow: string, step: string, fields?: Fields) =>
    console.log(fmt("info", `${flow}.${step}`, fields)),
};

export function errMsg(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

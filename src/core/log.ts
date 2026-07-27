/**
 * Tiny structured logger. Never logs secrets — callers pass only public fields
 * (addresses, step names, error messages). Errors are decoded to their message,
 * never their stack-with-locals.
 */
type Fields = Record<string, string | number | boolean | undefined>;

function fmt(level: string, event: string, fields?: Fields): string {
  const parts = [`[${level}]`, event];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) parts.push(`${k}=${typeof v === "string" ? v : String(v)}`);
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
  return err instanceof Error ? err.message : String(err);
}

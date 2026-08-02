/**
 * Telegram HTML formatting helpers.
 *
 * We use HTML parse mode (not legacy Markdown) everywhere. Legacy Markdown is
 * notoriously fragile — a single stray `_`, `*`, `[` or `` ` `` in dynamic
 * content makes Telegram reject the whole message with a 400 "can't parse
 * entities", which used to surface as "nothing happened" after an action.
 * HTML only treats &, <, > as special, so escaping dynamic values is reliable.
 */

/** Escape a raw string for insertion into Telegram HTML. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const b = (s: string): string => `<b>${esc(s)}</b>`;
export const i = (s: string): string => `<i>${esc(s)}</i>`;
export const code = (s: string): string => `<code>${esc(s)}</code>`;
export const link = (text: string, url: string): string =>
  `<a href="${esc(url)}">${esc(text)}</a>`;

/**
 * Render an LLM's Markdown answer as Telegram HTML.
 *
 * GUIDE-mode replies come back in Markdown (`**bold**`, `` `code` ``), but we
 * send with parse_mode HTML — so escaping alone printed the asterisks
 * literally ("**Swap tokens**"). Escape FIRST (so user/model text can never
 * inject tags), then convert the small Markdown subset we allow.
 */
export function mdToHtml(text: string): string {
  let out = esc(text);
  out = out.replace(/```([\s\S]*?)```/g, (_m, code: string) => `<pre>${code.trim()}</pre>`);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>");
  out = out.replace(/^\s*[-•]\s+/gm, "• ");
  return out;
}

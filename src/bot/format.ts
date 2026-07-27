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

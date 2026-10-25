/**
 * Provider-agnostic token estimate. Text is approximated as ASCII/4 chars plus
 * one token per CJK or emoji code point. It is used for budget checks and UI
 * hints only; authoritative counts come from provider usage events.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f000 && code <= 0x1faff) ||
      (code >= 0x20000 && code <= 0x3fffd)
    ) {
      wide += 1;
    } else {
      ascii += 1;
    }
  }
  return Math.ceil(ascii / 4) + wide;
}

export function estimateJsonTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return estimateTokens(text);
}

/** Keep the head and tail of oversized text, inserting an explicit marker. */
export function truncateMiddle(text: string, maxChars: number, marker = '\n[... output truncated ...]\n'): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= marker.length) return text.slice(0, Math.max(0, maxChars));
  const remaining = maxChars - marker.length;
  const headChars = Math.ceil(remaining / 2);
  const tailChars = remaining - headChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
  return head + marker + tail;
}

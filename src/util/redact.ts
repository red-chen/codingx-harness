export interface RedactionResult<T> {
  value: T;
  redacted: boolean;
}

const SIMPLE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED:private-key]',
  ],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:anthropic-api-key]'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai-api-key]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:github-pat]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED:github-token]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-access-key]'],
  [/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED:google-api-key]'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'Bearer [REDACTED:bearer-token]'],
];

const ENV_ASSIGNMENT = /\b(API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|ACCESS_KEY)\s*=\s*(?!\[REDACTED:)[^\s"'\x60]{8,}/gi;

/** Redact common credential shapes from free-form text. */
export function redactString(input: string): RedactionResult<string> {
  let text = input;
  let redacted = false;
  for (const [pattern, marker] of SIMPLE_PATTERNS) {
    text = text.replace(pattern, () => {
      redacted = true;
      return marker;
    });
  }
  text = text.replace(ENV_ASSIGNMENT, (_match: string, name: string) => {
    redacted = true;
    return name + '=[REDACTED:secret]';
  });
  return { value: text, redacted };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively redact string values in a JSON-like structure. The input is not
 * mutated; objects/arrays are copied only when needed.
 */
export function redactDeep<T>(input: T): RedactionResult<T> {
  if (typeof input === 'string') {
    const result = redactString(input);
    return { value: result.value as unknown as T, redacted: result.redacted };
  }
  if (Array.isArray(input)) {
    let redacted = false;
    const value = input.map((item) => {
      const result = redactDeep(item);
      redacted = redacted || result.redacted;
      return result.value;
    });
    return { value: value as unknown as T, redacted };
  }
  if (isPlainObject(input)) {
    let redacted = false;
    const value: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const result = redactDeep(item);
      redacted = redacted || result.redacted;
      value[key] = result.value;
    }
    return { value: value as unknown as T, redacted };
  }
  return { value: input, redacted: false };
}

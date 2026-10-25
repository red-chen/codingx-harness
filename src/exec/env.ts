const CREDENTIAL_NAME = /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|AUTH)(_|$)/i;

function isCredentialName(name: string): boolean {
  return name.startsWith('CODINGX_') || CREDENTIAL_NAME.test(name);
}

function defaultPath(): string {
  return process.platform === 'win32'
    ? 'C:\\Windows\\System32;C:\\Windows'
    : '/usr/local/bin:/usr/bin:/bin';
}

/**
 * Build the environment for a tool child process. Only whitelisted names are
 * copied, and credential-like names are dropped even when whitelisted.
 */
export function buildChildEnv(
  passthrough: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  const allowed = new Set(passthrough);
  for (const name of allowed) {
    if (isCredentialName(name)) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (allowed.has('PATH') && env.PATH === undefined) env.PATH = defaultPath();
  for (const [name, value] of Object.entries(extra)) {
    if (isCredentialName(name)) continue;
    env[name] = value;
  }
  return env;
}

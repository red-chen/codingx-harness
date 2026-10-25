import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AuthError } from './errors.js';

export interface ApiKeyResolution {
  apiKey: string;
  source: 'env' | 'auth-file';
}

export interface AuthJsonProvider {
  apiKey?: unknown;
}

export interface AuthJson {
  apiKey?: unknown;
  providers?: Record<string, AuthJsonProvider | string>;
}

export interface ResolveApiKeyOptions {
  providerId: string;
  /** The provider config only needs apiKeyEnv. */
  provider: { apiKeyEnv: string };
  codingxHome: string;
  env?: NodeJS.ProcessEnv;
  /** Override for tests; defaults to <codingxHome>/auth.json. */
  authFilePath?: string;
  /** POSIX only; defaults to true and enforces 0600. */
  enforcePermissions?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Credentials live outside config.toml. Resolution order:
 *   1. the provider's api_key_env environment variable
 *   2. <CODINGX_HOME>/auth.json -> providers.<id>.apiKey
 */
export async function resolveApiKey(options: ResolveApiKeyOptions): Promise<ApiKeyResolution> {
  const env = options.env ?? process.env;
  const fromEnv = env[options.provider.apiKeyEnv]?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: 'env' };

  const authPath = options.authFilePath ?? path.join(options.codingxHome, 'auth.json');
  const auth = await readAuthFile(authPath, options.enforcePermissions ?? true);
  if (!auth) {
    throw new AuthError(
      'No API key for provider "' +
        options.providerId +
        '". Set ' +
        options.provider.apiKeyEnv +
        ' or add {"providers":{"' +
        options.providerId +
        '":{"apiKey":"..."}}} to ' +
        authPath +
        ' (chmod 600).',
    );
  }

  const entry = auth.providers?.[options.providerId];
  const providerKey =
    typeof entry === 'string' ? entry.trim() : isPlainObject(entry) && typeof entry.apiKey === 'string' ? entry.apiKey.trim() : '';
  if (providerKey) return { apiKey: providerKey, source: 'auth-file' };

  const globalKey = typeof auth.apiKey === 'string' ? auth.apiKey.trim() : '';
  if (globalKey) return { apiKey: globalKey, source: 'auth-file' };

  throw new AuthError(
    'auth.json does not contain a key for provider "' +
      options.providerId +
      '". Add providers.' +
      options.providerId +
      '.apiKey to ' +
      authPath +
      '.',
  );
}

export async function readAuthFile(authPath: string, enforcePermissions = true): Promise<AuthJson | undefined> {
  let info;
  try {
    info = await stat(authPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AuthError('Cannot read auth file ' + authPath + ': ' + (error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
  if (!info.isFile()) throw new AuthError('Auth path is not a regular file: ' + authPath);
  if (enforcePermissions && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    const mode = (info.mode & 0o777).toString(8).padStart(3, '0');
    throw new AuthError('Auth file ' + authPath + ' has permissions 0o' + mode + '; run chmod 600 ' + authPath + '.');
  }

  let text: string;
  try {
    text = await readFile(authPath, 'utf8');
  } catch (error) {
    throw new AuthError('Cannot read auth file ' + authPath + ': ' + (error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AuthError('Invalid JSON in auth file ' + authPath + ': ' + (error instanceof Error ? error.message : String(error)), {
      cause: error,
    });
  }
  if (!isPlainObject(parsed)) throw new AuthError('Auth file ' + authPath + ' must contain a JSON object.');
  return parsed as AuthJson;
}

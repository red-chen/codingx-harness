import type { ProviderConfig } from '../config/types.js';
import { AuthError, UnsupportedError } from '../util/errors.js';
import { AnthropicMessagesProvider } from './anthropic/messages-provider.js';
import type { Provider } from './types.js';

export interface ProviderFactoryOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  anthropicVersion?: string;
}

/** Build a protocol adapter from [provider.<id>] config. */
export function createProvider(
  id: string,
  config: ProviderConfig,
  apiKey: string,
  options: ProviderFactoryOptions = {},
): Provider {
  if (!apiKey.trim()) throw new AuthError('No API key supplied for provider "' + id + '".');
  switch (config.protocol) {
    case 'anthropic-messages':
      return new AnthropicMessagesProvider({
        id,
        endpoint: config.endpoint,
        apiKey,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(options.anthropicVersion ? { version: options.anthropicVersion } : {}),
      });
    case 'openai-responses':
      throw new UnsupportedError(
        'Provider "' + id + '" uses the openai-responses protocol, which is planned for M4. ' +
          'Use protocol = "anthropic-messages" for M1.',
      );
    default:
      throw new UnsupportedError('Unknown provider protocol for "' + id + '": ' + String(config.protocol));
  }
}

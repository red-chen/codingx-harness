/** Stable error codes surfaced to the CLI, UI and tests. */
export type ErrorCode =
  | 'CONFIG_ERROR'
  | 'AUTH_ERROR'
  | 'PROVIDER_ERROR'
  | 'NO_HEALTHY_PROVIDER'
  | 'SESSION_ERROR'
  | 'SESSION_BUSY'
  | 'TOOL_ERROR'
  | 'PROCESS_NOT_FOUND'
  | 'PROCESS_LIMIT'
  | 'PROCESS_UNAVAILABLE'
  | 'STEP_LIMIT'
  | 'ABORTED'
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'POLICY_FORBIDDEN'
  | 'SANDBOX_UNAVAILABLE'
  | 'SANDBOX_DENIED'
  | 'HOOK_BLOCKED'
  | 'PERMISSION_PROFILE_UNKNOWN'
  | 'PERMISSION_CONFIG_CONFLICT'
  | 'INTERNAL';

export interface CodingxErrorOptions {
  cause?: unknown;
  exitCode?: number;
  details?: Record<string, unknown>;
}

const DEFAULT_EXIT_CODES: Record<ErrorCode, number> = {
  CONFIG_ERROR: 2,
  AUTH_ERROR: 2,
  PROVIDER_ERROR: 1,
  NO_HEALTHY_PROVIDER: 1,
  SESSION_ERROR: 1,
  SESSION_BUSY: 1,
  TOOL_ERROR: 1,
  PROCESS_NOT_FOUND: 1,
  PROCESS_LIMIT: 1,
  PROCESS_UNAVAILABLE: 1,
  STEP_LIMIT: 1,
  ABORTED: 130,
  UNSUPPORTED: 2,
  PERMISSION_DENIED: 1,
  APPROVAL_REQUIRED: 1,
  POLICY_FORBIDDEN: 1,
  SANDBOX_UNAVAILABLE: 1,
  SANDBOX_DENIED: 1,
  HOOK_BLOCKED: 1,
  PERMISSION_PROFILE_UNKNOWN: 2,
  PERMISSION_CONFIG_CONFLICT: 2,
  INTERNAL: 1,
};

export class CodingxError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: CodingxErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CodingxError';
    this.code = code;
    this.exitCode = options.exitCode ?? DEFAULT_EXIT_CODES[code];
    if (options.details) this.details = options.details;
  }
}

export class ConfigError extends CodingxError {
  constructor(message: string, options: CodingxErrorOptions = {}) {
    super('CONFIG_ERROR', message, options);
    this.name = 'ConfigError';
  }
}

export class AuthError extends CodingxError {
  constructor(message: string, options: CodingxErrorOptions = {}) {
    super('AUTH_ERROR', message, options);
    this.name = 'AuthError';
  }
}

export class SessionError extends CodingxError {
  constructor(message: string, options: CodingxErrorOptions = {}) {
    super('SESSION_ERROR', message, options);
    this.name = 'SessionError';
  }
}

export class SessionBusyError extends CodingxError {
  constructor(message: string, options: CodingxErrorOptions = {}) {
    super('SESSION_BUSY', message, options);
    this.name = 'SessionBusyError';
  }
}

export class ToolError extends CodingxError {
  constructor(message: string, options: CodingxErrorOptions = {}) {
    super('TOOL_ERROR', message, options);
    this.name = 'ToolError';
  }
}

export class ExecError extends CodingxError {
  constructor(message: string, options: CodingxErrorOptions = {}) {
    super('TOOL_ERROR', message, options);
    this.name = 'ExecError';
  }
}

export class UnsupportedError extends CodingxError {
  constructor(message: string, options: CodingxErrorOptions = {}) {
    super('UNSUPPORTED', message, options);
    this.name = 'UnsupportedError';
  }
}

export class StepLimitError extends CodingxError {
  readonly maxSteps: number;

  constructor(maxSteps: number) {
    super('STEP_LIMIT', 'Reached the maximum of ' + maxSteps + ' model steps in this turn without finishing.');
    this.name = 'StepLimitError';
    this.maxSteps = maxSteps;
  }
}

export type ProviderErrorCategory =
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'auth'
  | 'bad_request'
  | 'content_policy'
  | 'context_overflow'
  | 'protocol'
  | 'aborted';

export interface ProviderErrorOptions extends CodingxErrorOptions {
  category?: ProviderErrorCategory;
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
}

/** Errors raised by provider adapters. Retry policy lives in the router. */
export class ProviderError extends CodingxError {
  readonly category: ProviderErrorCategory;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super('PROVIDER_ERROR', message, options);
    this.name = 'ProviderError';
    this.category = options.category ?? 'protocol';
    if (options.status !== undefined) this.status = options.status;
    this.retryable = options.retryable ?? isRetryableCategory(this.category);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export function isRetryableCategory(category: ProviderErrorCategory): boolean {
  return category === 'network' || category === 'timeout' || category === 'rate_limit' || category === 'server';
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof CodingxError) return error.code === 'ABORTED';
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

export function abortError(message = 'Operation aborted'): CodingxError {
  return new CodingxError('ABORTED', message, { exitCode: 130 });
}

export interface ErrorSummary {
  code: ErrorCode | 'UNKNOWN';
  message: string;
  exitCode: number;
  category?: string;
  status?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export function describeError(error: unknown): ErrorSummary {
  if (error instanceof ProviderError) {
    return {
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
      category: error.category,
      ...(error.status === undefined ? {} : { status: error.status }),
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof CodingxError) {
    return {
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof Error) {
    return { code: 'UNKNOWN', message: error.message, exitCode: 1 };
  }
  return { code: 'UNKNOWN', message: String(error), exitCode: 1 };
}

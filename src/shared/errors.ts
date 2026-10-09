export class XaiOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly reloginRequired = false,
  ) {
    super(message);
    this.name = 'XaiOAuthError';
  }
}

export const XaiErrorCode = {
  DISCOVERY_FAILED: 'discovery_failed',
  DISCOVERY_INVALID_ORIGIN: 'discovery_invalid_origin',
  AUTHORIZATION_FAILED: 'authorization_failed',
  STATE_MISMATCH: 'state_mismatch',
  CODE_MISSING: 'code_missing',
  TOKEN_EXCHANGE_FAILED: 'token_exchange_failed',
  TOKEN_EXCHANGE_INVALID: 'token_exchange_invalid',
  DEVICE_AUTHORIZATION_UNAVAILABLE: 'device_authorization_unavailable',
  DEVICE_AUTHORIZATION_FAILED: 'device_authorization_failed',
  DEVICE_AUTHORIZATION_INVALID: 'device_authorization_invalid',
  REFRESH_MISSING: 'refresh_missing',
  REFRESH_FAILED: 'refresh_failed',
  AUTH_MISSING: 'auth_missing',
  CALLBACK_BIND_FAILED: 'callback_bind_failed',
  CALLBACK_TIMEOUT: 'callback_timeout',
} as const;

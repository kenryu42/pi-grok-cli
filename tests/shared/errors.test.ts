import { describe, expect, it } from 'vitest';
import { XaiErrorCode, XaiOAuthError } from '../../src/shared/errors.js';

describe('OAuth errors', () => {
  it('keeps machine-readable code and relogin state', () => {
    const error = new XaiOAuthError('Refresh token was revoked', XaiErrorCode.REFRESH_FAILED, true);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('XaiOAuthError');
    expect(error.message).toBe('Refresh token was revoked');
    expect(error.code).toBe('refresh_failed');
    expect(error.reloginRequired).toBe(true);
  });
});

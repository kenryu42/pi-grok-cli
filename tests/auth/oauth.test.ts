import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBaseUrl, login, refresh } from '../../src/auth/oauth.js';
import { XaiErrorCode } from '../../src/shared/errors.js';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const storedRefreshCredentials = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: 0,
  tokenEndpoint: 'https://auth.x.ai/oauth/token',
};
const credentialsWithoutEndpoint = {
  access: 'old-access',
  refresh: 'old-refresh',
  expires: 0,
};
const discoveryDocument = {
  authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
  token_endpoint: 'https://auth.x.ai/oauth/token',
};

function authorizeCallback(auth: { url: string }) {
  const url = new URL(auth.url);
  void originalFetch(
    `${url.searchParams.get('redirect_uri')}?code=callback-code&state=${url.searchParams.get('state')}`,
  );
}

afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OAuth helpers without network access', () => {
  it('resolves and trims the configured base URL', () => {
    delete process.env.GROK_CLI_BASE_URL;
    delete process.env.PI_GROK_CLI_BASE_URL;
    expect(getBaseUrl()).toBe('https://cli-chat-proxy.grok.com/v1');

    process.env.GROK_CLI_BASE_URL = 'https://example.invalid/v1///';
    expect(getBaseUrl()).toBe('https://example.invalid/v1');

    process.env.PI_GROK_CLI_BASE_URL = 'https://override.invalid/api//';
    expect(getBaseUrl()).toBe('https://override.invalid/api');
  });

  it('rejects refresh credentials with no refresh token before fetching', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;

    await expect(
      refresh({
        access: 'access-token',
        refresh: '',
        expires: 0,
        tokenEndpoint: 'https://auth.x.ai/oauth/token',
      }),
    ).rejects.toMatchObject({
      code: XaiErrorCode.REFRESH_MISSING,
      reloginRequired: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes credentials with the configured token endpoint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    process.env.PI_GROK_CLI_BASE_URL = 'https://proxy.example/v1//';
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 600,
        id_token: 'new-id',
        token_type: 'DPoP',
      }),
    );
    globalThis.fetch = fetchMock;

    await expect(
      refresh({
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 0,
        tokenEndpoint: 'https://auth.x.ai/oauth/token',
        idToken: 'old-id',
        tokenType: 'Bearer',
      }),
    ).resolves.toMatchObject({
      access: 'new-access',
      refresh: 'new-refresh',
      expires: 1_700_000_480_000,
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
      idToken: 'new-id',
      tokenType: 'DPoP',
      baseUrl: 'https://proxy.example/v1',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://auth.x.ai/oauth/token');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });
    expect((fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams).toString()).toBe(
      'grant_type=refresh_token&client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=old-refresh',
    );
  });

  it('keeps the existing refresh token and metadata when refresh omits optional fields', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'new-access', expires_in: '900' }),
    );
    globalThis.fetch = fetchMock;

    await expect(
      refresh({
        access: 'old-access',
        refresh: 'old-refresh',
        expires: 0,
        discovery: {
          authorization_endpoint: 'https://auth.x.ai/oauth/authorize',
          token_endpoint: 'https://accounts.x.ai/oauth/token',
        },
        idToken: 'old-id',
        tokenType: 'Bearer',
      }),
    ).resolves.toMatchObject({
      access: 'new-access',
      refresh: 'old-refresh',
      tokenEndpoint: 'https://accounts.x.ai/oauth/token',
      idToken: 'old-id',
      tokenType: 'Bearer',
    });
  });

  it('marks unauthorized refresh failures as requiring login', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('revoked', { status: 401 }));
    globalThis.fetch = fetchMock;

    await expect(refresh(storedRefreshCredentials)).rejects.toMatchObject({
      code: XaiErrorCode.REFRESH_FAILED,
      reloginRequired: true,
      message: 'xAI token refresh failed: 401 revoked',
    });
  });

  it('keeps server refresh failures retryable', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('temporarily unavailable', { status: 500 }),
    );
    globalThis.fetch = fetchMock;

    await expect(refresh(storedRefreshCredentials)).rejects.toMatchObject({
      code: XaiErrorCode.REFRESH_FAILED,
      reloginRequired: false,
      message: 'xAI token refresh failed: 500 temporarily unavailable',
    });
  });

  it('rejects refresh responses without an access token', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({}));
    globalThis.fetch = fetchMock;

    await expect(refresh(storedRefreshCredentials)).rejects.toMatchObject({
      code: XaiErrorCode.REFRESH_FAILED,
      reloginRequired: true,
      message: 'xAI token refresh did not return access_token.',
    });
  });

  it('wraps refresh transport and JSON failures', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      throw new Error('socket closed');
    });

    await expect(refresh(storedRefreshCredentials)).rejects.toMatchObject({
      code: XaiErrorCode.REFRESH_FAILED,
      message: 'xAI token refresh failed: socket closed',
    });

    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response('<html>proxy error</html>', { status: 200 }),
    );

    await expect(refresh(storedRefreshCredentials)).rejects.toMatchObject({
      code: XaiErrorCode.REFRESH_FAILED,
      message: expect.stringContaining('xAI token refresh returned invalid JSON:'),
    });
  });

  it('rejects unsafe token endpoints before fetching', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;

    await expect(
      refresh({
        ...storedRefreshCredentials,
        tokenEndpoint: 'https://evil.example/oauth/token',
      }),
    ).rejects.toMatchObject({
      code: XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
      message: 'Refusing non-xAI OAuth token_endpoint: https://evil.example/oauth/token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers the token endpoint when credentials do not include it', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(discoveryDocument);
      }
      return Response.json({ access_token: 'new-access' });
    });
    globalThis.fetch = fetchMock;

    await expect(refresh(credentialsWithoutEndpoint)).resolves.toMatchObject({
      access: 'new-access',
      refresh: 'old-refresh',
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://auth.x.ai/.well-known/openid-configuration',
      'https://auth.x.ai/oauth/token',
    ]);
  });

  it('wraps discovery network failures', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => {
      throw new Error('network down');
    });

    await expect(refresh(credentialsWithoutEndpoint)).rejects.toMatchObject({
      code: XaiErrorCode.DISCOVERY_FAILED,
      message: 'xAI OIDC discovery failed: network down',
    });
  });

  it('wraps malformed discovery JSON as discovery failure', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response('<html>proxy error</html>', { status: 200 }),
    );

    await expect(refresh(credentialsWithoutEndpoint)).rejects.toMatchObject({
      code: XaiErrorCode.DISCOVERY_FAILED,
      message: expect.stringContaining('xAI OIDC discovery returned invalid JSON:'),
    });
  });

  it('rejects failed and invalid discovery responses', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(
      async () => new Response('unavailable', { status: 503 }),
    );
    await expect(refresh(credentialsWithoutEndpoint)).rejects.toMatchObject({
      code: XaiErrorCode.DISCOVERY_FAILED,
      message: 'xAI OIDC discovery returned 503',
    });

    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        authorization_endpoint: 'http://auth.x.ai/oauth/authorize',
        token_endpoint: 'https://auth.x.ai/oauth/token',
      }),
    );
    await expect(refresh(credentialsWithoutEndpoint)).rejects.toMatchObject({
      code: XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
      message: 'xAI OAuth authorization_endpoint must use HTTPS: http://auth.x.ai/oauth/authorize',
    });
  });

  it('logs in with a loopback callback and exchanges the authorization code', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(discoveryDocument);
      }
      return Response.json({
        access_token: 'login-access',
        refresh_token: 'login-refresh',
        expires_in: 900,
        id_token: 'login-id',
        token_type: 'Bearer',
      });
    });
    globalThis.fetch = fetchMock;

    await expect(
      login({
        onAuth: authorizeCallback,
      }),
    ).resolves.toMatchObject({
      access: 'login-access',
      refresh: 'login-refresh',
      expires: 1_700_000_780_000,
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
      discovery: discoveryDocument,
      idToken: 'login-id',
      tokenType: 'Bearer',
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://auth.x.ai/oauth/token');
    expect((fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams).get('code')).toBe(
      'callback-code',
    );
  });

  it('reports callback timeouts with a dedicated error code', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn<typeof fetch>(async () => Response.json(discoveryDocument));
    const onAuth = vi.fn();
    const resultPromise = login({ onAuth }).then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.waitFor(() => expect(onAuth).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(180_000);

    await expect(resultPromise).resolves.toMatchObject({
      code: XaiErrorCode.CALLBACK_TIMEOUT,
      message: 'Timed out waiting for xAI OAuth callback.',
    });
  });

  it('wraps token exchange transport and JSON failures', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(discoveryDocument);
      }
      throw new Error('exchange socket closed');
    });
    globalThis.fetch = fetchMock;

    await expect(
      login({
        onAuth: authorizeCallback,
      }),
    ).rejects.toMatchObject({
      code: XaiErrorCode.TOKEN_EXCHANGE_FAILED,
      message: 'xAI token exchange failed: exchange socket closed',
    });

    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(discoveryDocument);
      }
      return new Response('<html>proxy error</html>', { status: 200 });
    });

    await expect(
      login({
        onAuth: authorizeCallback,
      }),
    ).rejects.toMatchObject({
      code: XaiErrorCode.TOKEN_EXCHANGE_FAILED,
      message: expect.stringContaining('xAI token exchange returned invalid JSON:'),
    });
  });
});

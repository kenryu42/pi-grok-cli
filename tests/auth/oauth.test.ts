import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeCallbackServer,
  getBaseUrl,
  login as loginWithCredentialReader,
  refresh,
  type XaiOAuthCredentials,
} from '../../src/auth/oauth.js';
import { XaiErrorCode } from '../../src/shared/errors.js';

type CompleteOAuthLoginCallbacks = Parameters<typeof loginWithCredentialReader>[0];
type OAuthLoginCallbacks = Partial<CompleteOAuthLoginCallbacks>;
const login = (callbacks: OAuthLoginCallbacks) =>
  loginWithCredentialReader(callbacks as CompleteOAuthLoginCallbacks, async () => undefined);
const loginWithCredentialsForTest = (
  callbacks: OAuthLoginCallbacks,
  credentials: XaiOAuthCredentials,
) => loginWithCredentialReader(callbacks as CompleteOAuthLoginCallbacks, async () => credentials);

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
const deviceDiscoveryDocument = {
  ...discoveryDocument,
  device_authorization_endpoint: 'https://auth.x.ai/oauth/device/code',
};
function officialCredentials(expires: number): XaiOAuthCredentials {
  return {
    access: 'official-access',
    refresh: 'official-refresh',
    expires,
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
  };
}

function deviceAuthorizationResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    device_code: 'device-code',
    user_code: 'ABCD-EFGH',
    verification_uri: 'https://accounts.x.ai/oauth/device',
    verification_uri_complete: 'https://accounts.x.ai/oauth/device?user_code=ABCD-EFGH',
    expires_in: 1800,
    interval: 5,
    ...overrides,
  });
}

function deviceLoginCallbacks(onDeviceCode = vi.fn()) {
  return {
    onSelect: async () => 'device',
    onDeviceCode,
  } as unknown as OAuthLoginCallbacks;
}

async function fetchCallback(input: string | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Connection', 'close');
  const response = await originalFetch(input, { ...init, headers });
  await response.text();
  return response;
}

function authorizeCallback(auth: { url: string }) {
  const url = new URL(auth.url);
  void fetchCallback(
    `${url.searchParams.get('redirect_uri')}?code=callback-code&state=${url.searchParams.get('state')}`,
  );
}

function callbackUrl(auth: { url: string }, query: string) {
  const url = new URL(auth.url);
  return `${url.searchParams.get('redirect_uri')}?${query}`;
}

function mockBrowserLogin(
  token: Record<string, unknown> = { access_token: 'access', refresh_token: 'refresh' },
  discovery: Record<string, unknown> = discoveryDocument,
) {
  const fetchMock = vi.fn<typeof fetch>(async (input) =>
    input === 'https://auth.x.ai/.well-known/openid-configuration'
      ? Response.json(discovery)
      : Response.json(token),
  );
  globalThis.fetch = fetchMock;
  return fetchMock;
}

async function rejectCallbackThenAuthorize(auth: { url: string }, invalidQuery: string) {
  await expect(fetchCallback(callbackUrl(auth, invalidQuery))).resolves.toMatchObject({
    status: 400,
  });
  await fetchCallback(
    callbackUrl(auth, `code=accepted&state=${new URL(auth.url).searchParams.get('state')}`),
  );
}

function manualCallback(build: (auth: { url: string }) => string) {
  let auth: { url: string } | undefined;
  return {
    onAuth: (value: { url: string }) => {
      auth = value;
    },
    onManualCodeInput: async () => {
      await vi.waitFor(() => expect(auth).toBeDefined());
      return build(auth as { url: string });
    },
  };
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
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const fetchMock = mockBrowserLogin({
      access_token: 'login-access',
      refresh_token: 'login-refresh',
      expires_in: 900,
      id_token: 'login-id',
      token_type: 'Bearer',
    });

    await expect(
      login({
        onAuth: (auth) => setTimeout(() => authorizeCallback(auth), 0),
      } as OAuthLoginCallbacks),
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

  it('answers trusted-origin CORS preflight requests before accepting the callback', async () => {
    mockBrowserLogin();
    let preflight: Response | undefined;

    await expect(
      login({
        onAuth: async (auth) => {
          const redirect = new URL(new URL(auth.url).searchParams.get('redirect_uri') ?? '');
          preflight = await fetchCallback(redirect, {
            method: 'OPTIONS',
            headers: { Origin: 'https://auth.x.ai' },
          });
          authorizeCallback(auth);
        },
      } as OAuthLoginCallbacks),
    ).resolves.toMatchObject({ access: 'access' });

    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get('access-control-allow-origin')).toBe('https://auth.x.ai');
    expect(preflight?.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(preflight?.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('reports a rejected token exchange response', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      input === 'https://auth.x.ai/.well-known/openid-configuration'
        ? Response.json(discoveryDocument)
        : new Response('authorization code expired', { status: 400 }),
    );
    globalThis.fetch = fetchMock;

    await expect(login({ onAuth: authorizeCallback } as OAuthLoginCallbacks)).rejects.toMatchObject(
      {
        code: XaiErrorCode.TOKEN_EXCHANGE_FAILED,
        message: 'xAI token exchange failed: 400 authorization code expired',
      },
    );
  });

  it.each([
    [{ refresh_token: 'refresh' }, 'access_token'],
    [{ access_token: 'access' }, 'refresh_token'],
  ])('rejects token exchange payloads missing %s', async (payload, field) => {
    mockBrowserLogin(payload);

    await expect(login({ onAuth: authorizeCallback } as OAuthLoginCallbacks)).rejects.toMatchObject(
      {
        code: XaiErrorCode.TOKEN_EXCHANGE_INVALID,
        message: `xAI token exchange did not return ${field}.`,
      },
    );
  });

  it('offers and returns fresh official Grok credentials without a network request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const onSelect = vi.fn(async () => 'existing');
    globalThis.fetch = fetchMock;

    await expect(
      loginWithCredentialsForTest(
        { onSelect, onDeviceCode: vi.fn() },
        officialCredentials(Date.now() + 60_000),
      ),
    ).resolves.toMatchObject({
      access: 'official-access',
      refresh: 'official-refresh',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    });
    expect(onSelect).toHaveBeenCalledWith({
      message: 'Select Grok CLI login method:',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device', label: 'Device code login (headless)' },
        { id: 'existing', label: 'Use existing Grok Build login' },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes selected expired official Grok credentials through the normal token path', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' }),
    );
    globalThis.fetch = fetchMock;

    await expect(
      loginWithCredentialsForTest({ onSelect: async () => 'existing' }, officialCredentials(0)),
    ).resolves.toMatchObject({
      access: 'refreshed-access',
      refresh: 'refreshed-refresh',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://auth.x.ai/oauth2/token');
  });

  it('returns to fresh login after official credential refresh fails without exposing tokens', async () => {
    const onProgress = vi.fn();
    const onSelect = vi
      .fn<CompleteOAuthLoginCallbacks['onSelect']>()
      .mockResolvedValueOnce('existing')
      .mockResolvedValueOnce('browser');
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/oauth2/token') {
        return new Response('revoked official credential', { status: 401 });
      }
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      return Response.json({ access_token: 'browser-access', refresh_token: 'browser-refresh' });
    });
    globalThis.fetch = fetchMock;

    await expect(
      loginWithCredentialsForTest(
        { onSelect, onProgress, onDeviceCode: vi.fn(), onAuth: authorizeCallback },
        officialCredentials(0),
      ),
    ).resolves.toMatchObject({ access: 'browser-access' });
    expect(onProgress).toHaveBeenCalledWith(
      'Existing Grok CLI login could not be refreshed. Choose a fresh login method.',
    );
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain('official-access');
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain('official-refresh');
  });

  it('ignores official credentials when browser login is selected', async () => {
    const fetchMock = mockBrowserLogin({
      access_token: 'browser-access',
      refresh_token: 'browser-refresh',
    });

    await expect(
      loginWithCredentialsForTest(
        { onSelect: async () => 'browser', onAuth: authorizeCallback },
        officialCredentials(Date.now() + 60_000),
      ),
    ).resolves.toMatchObject({ access: 'browser-access' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores an invalid-state HTTP callback and accepts the next valid callback', async () => {
    const fetchMock = mockBrowserLogin({
      access_token: 'login-access',
      refresh_token: 'login-refresh',
      expires_in: 900,
    });

    await expect(
      login({
        onAuth: (auth) => rejectCallbackThenAuthorize(auth, 'code=bad&state=wrong'),
      } as OAuthLoginCallbacks),
    ).resolves.toMatchObject({ access: 'login-access' });
    expect((fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams).get('code')).toBe('accepted');
  });

  it('ignores an HTTP callback without state', async () => {
    mockBrowserLogin();

    await expect(
      login({
        onAuth: (auth) => rejectCallbackThenAuthorize(auth, 'code=ignored'),
      } as OAuthLoginCallbacks),
    ).resolves.toMatchObject({ access: 'access' });
  });

  it.each([
    'other',
    `callback?state=missing-code`,
  ])('ignores an invalid HTTP callback path or payload: %s', async (suffix) => {
    mockBrowserLogin();

    await expect(
      login({
        onAuth: async (auth) => {
          const redirect = new URL(new URL(auth.url).searchParams.get('redirect_uri') ?? '');
          const invalid =
            suffix === 'other'
              ? `${redirect.origin}/other?code=ignored&state=${new URL(auth.url).searchParams.get('state')}`
              : `${redirect.origin}/${suffix}`;
          await expect(fetchCallback(invalid)).resolves.toMatchObject({
            status: suffix === 'other' ? 404 : 400,
          });
          authorizeCallback(auth);
        },
      } as OAuthLoginCallbacks),
    ).resolves.toMatchObject({ access: 'access' });
  });

  it('surfaces a matching-state OAuth error without exchanging a code', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(discoveryDocument);
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`);
    });
    globalThis.fetch = fetchMock;

    await expect(
      login({
        onAuth: (auth) => {
          void fetchCallback(
            callbackUrl(
              auth,
              `error=access_denied&error_description=Denied&state=${new URL(auth.url).searchParams.get('state')}`,
            ),
          );
        },
      } as OAuthLoginCallbacks),
    ).rejects.toMatchObject({
      code: XaiErrorCode.AUTHORIZATION_FAILED,
      message: 'Denied',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('exchanges only the first repeated valid HTTP callback', async () => {
    const fetchMock = mockBrowserLogin();

    await login({
      onAuth: (auth) => {
        const state = new URL(auth.url).searchParams.get('state');
        void fetchCallback(callbackUrl(auth, `code=first&state=${state}`))
          .then(() => fetchCallback(callbackUrl(auth, `code=second&state=${state}`)))
          .catch(() => undefined);
      },
    } as OAuthLoginCallbacks);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams).get('code')).toBe('first');
  });

  it.each([
    [
      'full callback URL',
      (auth: { url: string }) =>
        callbackUrl(auth, `code=manual&state=${new URL(auth.url).searchParams.get('state')}`),
    ],
    [
      'callback query',
      (auth: { url: string }) => `code=manual&state=${new URL(auth.url).searchParams.get('state')}`,
    ],
  ])('accepts a matching-state manual %s', async (_label, manualInput) => {
    const fetchMock = mockBrowserLogin({
      access_token: 'manual-access',
      refresh_token: 'manual-refresh',
    });
    await expect(login(manualCallback(manualInput) as OAuthLoginCallbacks)).resolves.toMatchObject({
      access: 'manual-access',
    });
    expect((fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams).get('code')).toBe('manual');
  });

  it('accepts a verified raw authorization code from the manual input channel', async () => {
    const authorizationCode =
      'synthetic_7A9B2C4D6E8F1G3H5J7K9M2N4P6Q8R1S3T5V7W9X2Y4Z6A8B1C3D5E7F9G2H4J6K';
    const controller = new AbortController();
    const onProgress = vi.fn(() => controller.abort());
    const fetchMock = mockBrowserLogin({
      access_token: 'manual-access',
      refresh_token: 'manual-refresh',
    });
    await expect(
      login({
        onAuth() {},
        onManualCodeInput: async () => authorizationCode,
        onProgress,
        signal: controller.signal,
      } as OAuthLoginCallbacks),
    ).resolves.toMatchObject({ access: 'manual-access' });
    expect(onProgress).not.toHaveBeenCalled();
    expect((fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams).get('code')).toBe(
      authorizationCode,
    );
  });

  it('reports and ignores invalid manual input while the HTTP callback remains active', async () => {
    const onProgress = vi.fn();
    mockBrowserLogin();

    await expect(
      login({
        onAuth: (auth) => {
          setTimeout(() => authorizeCallback(auth), 0);
        },
        onManualCodeInput: async () => 'code=ignored&state=wrong',
        onProgress,
      } as OAuthLoginCallbacks),
    ).resolves.toMatchObject({ access: 'access' });
    expect(onProgress).toHaveBeenCalledWith(
      "Ignored pasted callback: OAuth state did not match. Paste the complete callback URL or xAI's one-time code.",
    );
  });

  it.each([
    ['', 'Pasted callback was empty.'],
    ['not a callback', 'OAuth state is missing.'],
  ])('reports and ignores malformed manual input: %j', async (input, reason) => {
    const onProgress = vi.fn();
    mockBrowserLogin();

    await login({
      onAuth: (auth) => setTimeout(() => authorizeCallback(auth), 0),
      onManualCodeInput: async () => input,
      onProgress,
    } as OAuthLoginCallbacks);
    expect(onProgress).toHaveBeenCalledWith(
      `Ignored pasted callback: ${reason} Paste the complete callback URL or xAI's one-time code.`,
    );
  });

  it('makes late manual input a no-op after the HTTP callback wins', async () => {
    const onProgress = vi.fn();
    let resolveManual: ((value: string) => void) | undefined;
    mockBrowserLogin();

    await login({
      onAuth: (auth) => setTimeout(() => authorizeCallback(auth), 0),
      onManualCodeInput: () =>
        new Promise<string>((resolve) => {
          resolveManual = resolve;
        }),
      onProgress,
    } as OAuthLoginCallbacks);
    resolveManual?.('malformed');
    await Promise.resolve();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('closes the HTTP callback listener after manual input wins', async () => {
    let redirectUri = '';
    mockBrowserLogin();

    let authUrl = '';
    await login({
      onAuth: (auth) => {
        authUrl = auth.url;
        redirectUri = new URL(auth.url).searchParams.get('redirect_uri') ?? '';
      },
      onManualCodeInput: async () => {
        await vi.waitFor(() => expect(authUrl).not.toBe(''));
        return `${redirectUri}?code=manual&state=${new URL(authUrl).searchParams.get('state')}`;
      },
    } as OAuthLoginCallbacks);
    await expect(fetchCallback(redirectUri)).rejects.toThrow();
  });

  it('surfaces a matching-state manual OAuth error', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => Response.json(discoveryDocument));
    await expect(
      login(
        manualCallback(
          (auth) =>
            `error=access_denied&error_description=Denied&state=${new URL(auth.url).searchParams.get('state')}`,
        ) as OAuthLoginCallbacks,
      ),
    ).rejects.toMatchObject({ code: XaiErrorCode.AUTHORIZATION_FAILED, message: 'Denied' });
  });

  it('aborts browser login while waiting for both callback paths', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn<typeof fetch>(async () => Response.json(discoveryDocument));
    const onAuth = vi.fn(() => controller.abort());

    await expect(
      login({
        onAuth,
        onManualCodeInput: () => new Promise(() => undefined),
        signal: controller.signal,
      } as OAuthLoginCallbacks),
    ).rejects.toThrow('Login cancelled');
  });

  it('aborts browser login after callback waiting has started', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn<typeof fetch>(async () => Response.json(discoveryDocument));

    await expect(
      login({
        onAuth: () => setTimeout(() => controller.abort(), 0),
        signal: controller.signal,
      } as OAuthLoginCallbacks),
    ).rejects.toThrow('Login cancelled');
  });

  it('logs in with device authorization for SSH/headless sessions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const onSelect = vi.fn(async () => 'device');
    const onDeviceCode = vi.fn();
    const onProgress = vi.fn();
    let tokenPolls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      if (input === 'https://auth.x.ai/oauth/device/code') return deviceAuthorizationResponse();
      if (input !== 'https://auth.x.ai/oauth/token') {
        throw new Error(`Unexpected fetch URL: ${String(input)}`);
      }
      tokenPolls += 1;
      if (tokenPolls === 1) {
        return Response.json({ error: 'authorization_pending' }, { status: 400 });
      }
      return Response.json({
        access_token: 'device-access',
        refresh_token: 'device-refresh',
        expires_in: 900,
        id_token: 'device-id',
        token_type: 'Bearer',
      });
    });
    globalThis.fetch = fetchMock;

    const resultPromise = login({
      onSelect,
      onDeviceCode,
      onProgress,
    } as unknown as OAuthLoginCallbacks);

    await vi.waitFor(() => expect(onDeviceCode).toHaveBeenCalledOnce());
    expect(onSelect).toHaveBeenCalledWith({
      message: 'Select Grok CLI login method:',
      options: [
        { id: 'browser', label: 'Browser login (default)' },
        { id: 'device', label: 'Device code login (headless)' },
      ],
    });
    expect(onDeviceCode).toHaveBeenCalledWith({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://accounts.x.ai/oauth/device?user_code=ABCD-EFGH',
      intervalSeconds: 5,
      expiresInSeconds: 1800,
    });
    expect(onProgress).toHaveBeenCalledWith('Waiting for xAI device authorization...');

    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toMatchObject({
      access: 'device-access',
      refresh: 'device-refresh',
      expires: expect.any(Number),
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
      discovery: deviceDiscoveryDocument,
      idToken: 'device-id',
      tokenType: 'Bearer',
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://auth.x.ai/oauth/token');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://auth.x.ai/oauth/token');
    expect((fetchMock.mock.calls[3]?.[1]?.body as URLSearchParams).toString()).toBe(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=b1a00492-073a-47ea-816f-4c329264a828&device_code=device-code',
    );
  });

  it('rejects malformed device polling numbers before polling', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      if (input === 'https://auth.x.ai/oauth/device/code') {
        return deviceAuthorizationResponse({ interval: '5s' });
      }
      throw new Error(`Unexpected fetch URL: ${String(input)}`);
    });
    globalThis.fetch = fetchMock;

    await expect(login(deviceLoginCallbacks())).rejects.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
      message: 'xAI device authorization returned invalid interval.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports rejected and incomplete device authorization responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      return new Response('device authorization unavailable', { status: 503 });
    });
    globalThis.fetch = fetchMock;

    await expect(login(deviceLoginCallbacks())).rejects.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      message: 'xAI device authorization failed: 503 device authorization unavailable',
    });

    fetchMock.mockImplementation(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      return Response.json({ device_code: 'device-code' });
    });

    await expect(login(deviceLoginCallbacks())).rejects.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
      message:
        'xAI device authorization did not return device_code, user_code, and verification_uri.',
    });
  });

  it('honors slow_down and marks denied device authorization as requiring login', async () => {
    vi.useFakeTimers();
    const onDeviceCode = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      if (input === 'https://auth.x.ai/oauth/device/code') return deviceAuthorizationResponse();
      if (fetchMock.mock.calls.length === 3) {
        return Response.json({ error: 'slow_down' }, { status: 400 });
      }
      return Response.json(
        { error: 'access_denied', error_description: 'The user denied access.' },
        { status: 400 },
      );
    });
    globalThis.fetch = fetchMock;

    const resultPromise = login(deviceLoginCallbacks(onDeviceCode)).then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.waitFor(() => expect(onDeviceCode).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(resultPromise).resolves.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      message: 'xAI device authorization failed: 400 The user denied access.',
      reloginRequired: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('cancels device authorization while waiting to poll', async () => {
    const controller = new AbortController();
    const onDeviceCode = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      if (input === 'https://auth.x.ai/oauth/device/code') return deviceAuthorizationResponse();
      throw new Error(`Unexpected fetch URL: ${String(input)}`);
    });
    globalThis.fetch = fetchMock;

    const resultPromise = login({
      ...deviceLoginCallbacks(onDeviceCode),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(onDeviceCode).toHaveBeenCalledOnce());
    controller.abort();

    await expect(resultPromise).rejects.toThrow('Login cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out expired device authorization', async () => {
    vi.useFakeTimers();
    const onDeviceCode = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      if (input === 'https://auth.x.ai/oauth/device/code') {
        return deviceAuthorizationResponse({ expires_in: 1, interval: 1 });
      }
      return Response.json({ error: 'authorization_pending' }, { status: 400 });
    });
    globalThis.fetch = fetchMock;

    const resultPromise = login(deviceLoginCallbacks(onDeviceCode)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(onDeviceCode).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      message: 'Timed out waiting for xAI device authorization.',
    });
  });

  it('reports non-JSON device polling errors', async () => {
    vi.useFakeTimers();
    const onDeviceCode = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      if (input === 'https://auth.x.ai/oauth/device/code') {
        return deviceAuthorizationResponse({ interval: 1 });
      }
      return new Response('proxy error', { status: 400 });
    });
    globalThis.fetch = fetchMock;

    const resultPromise = login(deviceLoginCallbacks(onDeviceCode)).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(onDeviceCode).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      message: 'xAI device authorization failed: 400 proxy error',
    });
  });

  it('falls back to browser login when the UI has no device-code callback', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const onSelect = vi.fn(async () => 'device');
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(deviceDiscoveryDocument);
      }
      return Response.json({
        access_token: 'login-access',
        refresh_token: 'login-refresh',
        expires_in: 900,
      });
    });
    globalThis.fetch = fetchMock;

    await expect(
      login({
        onAuth: (auth: { url: string }) => setTimeout(() => authorizeCallback(auth), 0),
        onSelect,
      } as unknown as OAuthLoginCallbacks),
    ).resolves.toMatchObject({
      access: 'login-access',
      refresh: 'login-refresh',
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://auth.x.ai/.well-known/openid-configuration',
      'https://auth.x.ai/oauth/token',
    ]);
  });

  it('reports callback timeouts with a dedicated error code', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn<typeof fetch>(async () => Response.json(discoveryDocument));
    const onAuth = vi.fn();
    const resultPromise = login({ onAuth } as unknown as OAuthLoginCallbacks).then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.waitFor(() => expect(onAuth).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(180_000);

    await expect(resultPromise).resolves.toMatchObject({
      code: XaiErrorCode.CALLBACK_TIMEOUT,
      message: 'Timed out waiting for xAI OAuth callback.',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes callback servers idempotently', async () => {
    const { createServer } = await import('node:http');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const firstClose = closeCallbackServer(server);
    expect(closeCallbackServer(server)).toBe(firstClose);
    await expect(firstClose).resolves.toBeUndefined();
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
      } as OAuthLoginCallbacks),
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
      } as OAuthLoginCallbacks),
    ).rejects.toMatchObject({
      code: XaiErrorCode.TOKEN_EXCHANGE_FAILED,
      message: expect.stringContaining('xAI token exchange returned invalid JSON:'),
    });
  });
});

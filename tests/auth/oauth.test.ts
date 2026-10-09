import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  closeCallbackServer,
  getBaseUrl,
  login as oauthLogin,
  refresh,
} from '../../src/auth/oauth.js';
import { XaiErrorCode } from '../../src/shared/errors.js';

type CompleteOAuthLoginCallbacks = Parameters<typeof oauthLogin>[0];
type OAuthLoginCallbacks = Partial<CompleteOAuthLoginCallbacks>;
type DeviceCodeCallback = CompleteOAuthLoginCallbacks['onDeviceCode'];
type ProgressCallback = NonNullable<CompleteOAuthLoginCallbacks['onProgress']>;
type FetchInput = Parameters<typeof fetch>[0];
const login = (callbacks: OAuthLoginCallbacks) =>
  oauthLogin(callbacks as CompleteOAuthLoginCallbacks);

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

function deviceLoginCallbacks(onDeviceCode = vi.fn<DeviceCodeCallback>()) {
  return {
    onSelect: async () => 'device',
    onDeviceCode,
  } as unknown as OAuthLoginCallbacks;
}

function unexpectedFetch(input: FetchInput): never {
  throw new Error(
    `Unexpected fetch URL: ${input instanceof Request ? input.url : input.toString()}`,
  );
}

function mockDeviceLogin(
  pollToken: (input: FetchInput) => Response | Promise<Response> = unexpectedFetch,
  device: Record<string, unknown> = {},
) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
      return Response.json(deviceDiscoveryDocument);
    }
    if (input === 'https://auth.x.ai/oauth/device/code') return deviceAuthorizationResponse(device);
    return pollToken(input);
  });
  globalThis.fetch = fetchMock;
  return fetchMock;
}

async function failDeviceLogin(advanceMs: number) {
  vi.useFakeTimers();
  const onDeviceCode = vi.fn<DeviceCodeCallback>();
  const resultPromise = login(deviceLoginCallbacks(onDeviceCode)).then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(onDeviceCode).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(advanceMs);
  return resultPromise;
}

function requestBody(fetchMock: Mock<typeof fetch>, call: number) {
  const body = fetchMock.mock.calls[call]?.[1]?.body;
  expect(body).toBeInstanceOf(URLSearchParams);
  return body as URLSearchParams;
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
    expect(requestBody(fetchMock, 0).toString()).toBe(
      'grant_type=refresh_token&client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=old-refresh',
    );
  });

  it.each([
    ['omits optional fields', {}],
    [
      'returns non-string optional fields',
      { refresh_token: { value: 'new-refresh' }, id_token: { value: 'new-id' }, token_type: {} },
    ],
  ])('keeps the existing refresh token and metadata when refresh %s', async (_label, fields) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ access_token: 'new-access', expires_in: '900', ...fields }),
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

  it.each([{}, { access_token: { value: 'new-access' } }])(
    'rejects refresh responses without a string access token: %j',
    async (payload) => {
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json(payload));
      globalThis.fetch = fetchMock;

      await expect(refresh(storedRefreshCredentials)).rejects.toMatchObject({
        code: XaiErrorCode.REFRESH_FAILED,
        reloginRequired: true,
        message: 'xAI token refresh did not return access_token.',
      });
    },
  );

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
      message: expect.stringContaining('xAI token refresh returned invalid JSON:') as string,
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

  it('rejects a non-string device endpoint in discovery', async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...discoveryDocument,
        device_authorization_endpoint: { url: 'https://auth.x.ai/device' },
      }),
    );

    await expect(refresh(credentialsWithoutEndpoint)).rejects.toMatchObject({
      code: XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
      message: 'xAI OAuth discovery returned invalid device_authorization_endpoint: ',
    });
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
      message: expect.stringContaining('xAI OIDC discovery returned invalid JSON:') as string,
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

    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        authorization_endpoint: { url: 'https://auth.x.ai/oauth/authorize' },
        token_endpoint: 'https://auth.x.ai/oauth/token',
      }),
    );
    await expect(refresh(credentialsWithoutEndpoint)).rejects.toMatchObject({
      code: XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
      message: 'xAI OAuth discovery returned invalid authorization_endpoint: ',
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
    expect(requestBody(fetchMock, 1).get('code')).toBe('callback-code');
  });

  it('answers trusted-origin CORS preflight requests before accepting the callback', async () => {
    mockBrowserLogin();
    let preflight: Response | undefined;

    await expect(
      login({
        onAuth: (auth) => {
          const redirect = new URL(new URL(auth.url).searchParams.get('redirect_uri') ?? '');
          void fetchCallback(redirect, {
            method: 'OPTIONS',
            headers: { Origin: 'https://auth.x.ai' },
          }).then((response) => {
            preflight = response;
            authorizeCallback(auth);
          });
        },
      }),
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

    await expect(login({ onAuth: authorizeCallback })).rejects.toMatchObject({
      code: XaiErrorCode.TOKEN_EXCHANGE_FAILED,
      message: 'xAI token exchange failed: 400 authorization code expired',
    });
  });

  it('defaults non-string token metadata from the token exchange', async () => {
    mockBrowserLogin({
      access_token: 'access',
      refresh_token: 'refresh',
      id_token: { value: 'login-id' },
      token_type: { value: 'DPoP' },
    });

    await expect(login({ onAuth: authorizeCallback })).resolves.toMatchObject({
      access: 'access',
      refresh: 'refresh',
      idToken: '',
      tokenType: 'Bearer',
    });
  });

  it.each([
    [{ refresh_token: 'refresh' }, 'access_token'],
    [{ access_token: 'access' }, 'refresh_token'],
    [{ access_token: { value: 'access' }, refresh_token: 'refresh' }, 'access_token'],
    [{ access_token: 'access', refresh_token: { value: 'refresh' } }, 'refresh_token'],
  ])('rejects token exchange payloads missing %s', async (payload, field) => {
    mockBrowserLogin(payload);

    await expect(login({ onAuth: authorizeCallback })).rejects.toMatchObject({
      code: XaiErrorCode.TOKEN_EXCHANGE_INVALID,
      message: `xAI token exchange did not return ${field}.`,
    });
  });

  it('offers only fresh login methods when an official Grok auth file exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-grok-oauth-'));
    process.env.HOME = home;
    await mkdir(join(home, '.grok'));
    await writeFile(
      join(home, '.grok', 'auth.json'),
      JSON.stringify({
        'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
          key: 'official-access',
          refresh_token: 'official-refresh',
          expires_at: '2030-01-02T03:04:05.000Z',
          oidc_issuer: 'https://auth.x.ai',
          oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
        },
      }),
    );
    const fetchMock = mockBrowserLogin(
      {
        access_token: 'browser-access',
        refresh_token: 'browser-refresh',
      },
      deviceDiscoveryDocument,
    );
    const onSelect = vi.fn<CompleteOAuthLoginCallbacks['onSelect']>(async () => 'browser');

    try {
      await expect(
        login({
          onSelect,
          onDeviceCode: vi.fn<DeviceCodeCallback>(),
          onAuth: authorizeCallback,
        }),
      ).resolves.toMatchObject({ access: 'browser-access', refresh: 'browser-refresh' });
      expect(onSelect).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenCalledWith({
        message: 'Select Grok CLI login method:',
        options: [
          { id: 'browser', label: 'Browser login (default)' },
          { id: 'device', label: 'Device code login (headless)' },
        ],
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('official-access');
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('official-refresh');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('ignores an invalid-state HTTP callback and accepts the next valid callback', async () => {
    const fetchMock = mockBrowserLogin({
      access_token: 'login-access',
      refresh_token: 'login-refresh',
      expires_in: 900,
    });

    await expect(
      login({
        onAuth: (auth) => void rejectCallbackThenAuthorize(auth, 'code=bad&state=wrong'),
      }),
    ).resolves.toMatchObject({ access: 'login-access' });
    expect(requestBody(fetchMock, 1).get('code')).toBe('accepted');
  });

  it('ignores an HTTP callback without state', async () => {
    mockBrowserLogin();

    await expect(
      login({
        onAuth: (auth) => void rejectCallbackThenAuthorize(auth, 'code=ignored'),
      }),
    ).resolves.toMatchObject({ access: 'access' });
  });

  it.each(['other', `callback?state=missing-code`])(
    'ignores an invalid HTTP callback path or payload: %s',
    async (suffix) => {
      mockBrowserLogin();

      await expect(
        login({
          onAuth: (auth) => {
            const redirect = new URL(new URL(auth.url).searchParams.get('redirect_uri') ?? '');
            const invalid =
              suffix === 'other'
                ? `${redirect.origin}/other?code=ignored&state=${new URL(auth.url).searchParams.get('state')}`
                : `${redirect.origin}/${suffix}`;
            void fetchCallback(invalid).then((response) => {
              expect(response.status).toBe(suffix === 'other' ? 404 : 400);
              authorizeCallback(auth);
            });
          },
        }),
      ).resolves.toMatchObject({ access: 'access' });
    },
  );

  it('surfaces a matching-state OAuth error without exchanging a code', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (input === 'https://auth.x.ai/.well-known/openid-configuration') {
        return Response.json(discoveryDocument);
      }
      return unexpectedFetch(input);
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
      }),
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
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBody(fetchMock, 1).get('code')).toBe('first');
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
    expect(requestBody(fetchMock, 1).get('code')).toBe('manual');
  });

  it('accepts a verified raw authorization code from the manual input channel', async () => {
    const authorizationCode =
      'synthetic_7A9B2C4D6E8F1G3H5J7K9M2N4P6Q8R1S3T5V7W9X2Y4Z6A8B1C3D5E7F9G2H4J6K';
    const controller = new AbortController();
    const onProgress = vi.fn<ProgressCallback>(() => controller.abort());
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
      }),
    ).resolves.toMatchObject({ access: 'manual-access' });
    expect(onProgress).not.toHaveBeenCalled();
    expect(requestBody(fetchMock, 1).get('code')).toBe(authorizationCode);
  });

  it('reports and ignores invalid manual input while the HTTP callback remains active', async () => {
    const onProgress = vi.fn<ProgressCallback>();
    mockBrowserLogin();

    await expect(
      login({
        onAuth: (auth) => {
          setTimeout(() => authorizeCallback(auth), 0);
        },
        onManualCodeInput: async () => 'code=ignored&state=wrong',
        onProgress,
      }),
    ).resolves.toMatchObject({ access: 'access' });
    expect(onProgress).toHaveBeenCalledWith(
      "Ignored pasted callback: OAuth state did not match. Paste the complete callback URL or xAI's one-time code.",
    );
  });

  it.each([
    ['', 'Pasted callback was empty.'],
    ['not a callback', 'OAuth state is missing.'],
  ])('reports and ignores malformed manual input: %j', async (input, reason) => {
    const onProgress = vi.fn<ProgressCallback>();
    mockBrowserLogin();

    await login({
      onAuth: (auth) => setTimeout(() => authorizeCallback(auth), 0),
      onManualCodeInput: async () => input,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith(
      `Ignored pasted callback: ${reason} Paste the complete callback URL or xAI's one-time code.`,
    );
  });

  it('makes late manual input a no-op after the HTTP callback wins', async () => {
    const onProgress = vi.fn<ProgressCallback>();
    let resolveManual: ((value: string) => void) | undefined;
    mockBrowserLogin();

    await login({
      onAuth: (auth) => setTimeout(() => authorizeCallback(auth), 0),
      onManualCodeInput: () =>
        new Promise<string>((resolve) => {
          resolveManual = resolve;
        }),
      onProgress,
    });
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
    });
    await expect(fetchCallback(redirectUri)).rejects.toThrow('fetch failed');
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
    const onAuth = vi.fn<CompleteOAuthLoginCallbacks['onAuth']>(() => controller.abort());

    await expect(
      login({
        onAuth,
        onManualCodeInput: () => new Promise(() => undefined),
        signal: controller.signal,
      }),
    ).rejects.toThrow('Login cancelled');
  });

  it('aborts browser login after callback waiting has started', async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn<typeof fetch>(async () => Response.json(discoveryDocument));

    await expect(
      login({
        onAuth: () => setTimeout(() => controller.abort(), 0),
        signal: controller.signal,
      }),
    ).rejects.toThrow('Login cancelled');
  });

  it('logs in with device authorization for SSH/headless sessions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const onSelect = vi.fn<CompleteOAuthLoginCallbacks['onSelect']>(async () => 'device');
    const onDeviceCode = vi.fn<DeviceCodeCallback>();
    const onProgress = vi.fn<ProgressCallback>();
    let tokenPolls = 0;
    const fetchMock = mockDeviceLogin((input) => {
      if (input !== 'https://auth.x.ai/oauth/token') return unexpectedFetch(input);
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

    const resultPromise = login({
      onSelect,
      onDeviceCode,
      onProgress,
    });

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
      expires: expect.any(Number) as number,
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
      discovery: deviceDiscoveryDocument,
      idToken: 'device-id',
      tokenType: 'Bearer',
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe('https://auth.x.ai/oauth/token');
    expect(fetchMock.mock.calls[3]?.[0]).toBe('https://auth.x.ai/oauth/token');
    expect(requestBody(fetchMock, 3).toString()).toBe(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=b1a00492-073a-47ea-816f-4c329264a828&device_code=device-code',
    );
  });

  it('rejects malformed device polling numbers before polling', async () => {
    const fetchMock = mockDeviceLogin(unexpectedFetch, { interval: '5s' });

    await expect(login(deviceLoginCallbacks())).rejects.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
      message: 'xAI device authorization returned invalid interval.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { device_code: { value: 'device-code' } },
    { user_code: { value: 'ABCD-EFGH' } },
    { verification_uri: { value: 'uri' }, verification_uri_complete: { value: 'uri' } },
  ])('rejects non-string device authorization fields: %j', async (device) => {
    const onDeviceCode = vi.fn<DeviceCodeCallback>();
    mockDeviceLogin(unexpectedFetch, device);

    await expect(login(deviceLoginCallbacks(onDeviceCode))).rejects.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
      message:
        'xAI device authorization did not return device_code, user_code, and verification_uri.',
    });
    expect(onDeviceCode).not.toHaveBeenCalled();
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
    const fetchMock = mockDeviceLogin(async () =>
      fetchMock.mock.calls.length === 3
        ? Response.json({ error: 'slow_down' }, { status: 400 })
        : Response.json(
            { error: 'access_denied', error_description: 'The user denied access.' },
            { status: 400 },
          ),
    );

    await expect(failDeviceLogin(15_000)).resolves.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      message: 'xAI device authorization failed: 400 The user denied access.',
      reloginRequired: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    [{}, 'https://accounts.x.ai/oauth/device?user_code=ABCD-EFGH'],
    [{ verification_uri_complete: { value: 'uri' } }, 'https://accounts.x.ai/oauth/device'],
  ])('cancels device authorization while waiting to poll: %j', async (device, verificationUri) => {
    const controller = new AbortController();
    const onDeviceCode = vi.fn<DeviceCodeCallback>();
    const fetchMock = mockDeviceLogin(unexpectedFetch, device);

    const resultPromise = login({
      ...deviceLoginCallbacks(onDeviceCode),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(onDeviceCode).toHaveBeenCalledOnce());
    expect(onDeviceCode.mock.calls[0]?.[0].verificationUri).toBe(verificationUri);
    controller.abort();

    await expect(resultPromise).rejects.toThrow('Login cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'times out expired device authorization',
      { expires_in: 1, interval: 1 },
      () => Response.json({ error: 'authorization_pending' }, { status: 400 }),
      'Timed out waiting for xAI device authorization.',
    ],
    [
      'reports non-JSON device polling errors',
      { interval: 1 },
      () => new Response('proxy error', { status: 400 }),
      'xAI device authorization failed: 400 proxy error',
    ],
    [
      'reports non-string device polling error descriptions',
      { interval: 1 },
      () =>
        Response.json(
          { error: 'access_denied', error_description: { text: 'denied' } },
          { status: 400 },
        ),
      'xAI device authorization failed: 400 access_denied',
    ],
  ])('%s', async (_label, device, pollToken, message) => {
    mockDeviceLogin(pollToken, device);

    await expect(failDeviceLogin(1_000)).resolves.toMatchObject({
      code: XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      message,
    });
  });

  it('falls back to browser login when the UI has no device-code callback', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const onSelect = vi.fn<CompleteOAuthLoginCallbacks['onSelect']>(async () => 'device');
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
      }),
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
    const onAuth = vi.fn<CompleteOAuthLoginCallbacks['onAuth']>();
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
      message: expect.stringContaining('xAI token exchange returned invalid JSON:') as string,
    });
  });
});

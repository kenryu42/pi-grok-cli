/**
 * xAI Grok OAuth 2.0 + PKCE implementation.
 *
 * Uses Web Crypto API (crypto.subtle) for PKCE so the extension is
 * portable across Node versions and potential non-Node runtimes.
 *
 * The OAuth flow is identical to pi-grok — same client_id, same auth.x.ai
 * issuer. The difference is in the API endpoint: this extension targets
 * cli-chat-proxy.grok.com instead of api.x.ai.
 */

import { createServer } from 'node:http';
import { XaiErrorCode, XaiOAuthError } from '../shared/errors.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const ISSUER = 'https://auth.x.ai';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const CLIENT_ID = process.env.PI_GROK_CLI_OAUTH_CLIENT_ID || 'b1a00492-073a-47ea-816f-4c329264a828';
const SCOPE =
  process.env.PI_GROK_CLI_OAUTH_SCOPE ||
  'openid profile email offline_access grok-cli:access api:access';
const CALLBACK_HOST = process.env.PI_GROK_CLI_CALLBACK_HOST || '127.0.0.1';
const CALLBACK_PORT = Number.parseInt(process.env.PI_GROK_CLI_CALLBACK_PORT || '56122', 10);
const CALLBACK_PATH = '/callback';
/** Refresh 120s before actual expiry. */
const REFRESH_SKEW_MS = 120_000;
const TOKEN_REQUEST_TIMEOUT_MS = Number.parseInt(
  process.env.PI_GROK_CLI_TOKEN_TIMEOUT_MS || '30000',
  10,
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface XaiDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
}

export interface XaiOAuthCredentials {
  [key: string]: unknown;
  refresh: string;
  access: string;
  expires: number;
  tokenEndpoint?: string;
  discovery?: XaiDiscovery;
  idToken?: string;
  tokenType?: string;
  baseUrl?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getBaseUrl(): string {
  return (
    process.env.PI_GROK_CLI_BASE_URL ||
    process.env.GROK_CLI_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
}

function base64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

async function generatePKCE(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(hash) };
}

// ─── Endpoint validation ──────────────────────────────────────────────────────

function validateEndpoint(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XaiOAuthError(
      `xAI OAuth discovery returned invalid ${field}: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  if (url.protocol !== 'https:') {
    throw new XaiOAuthError(
      `xAI OAuth ${field} must use HTTPS: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  const host = url.hostname.toLowerCase();
  if (
    host !== 'x.ai' &&
    host !== 'auth.x.ai' &&
    host !== 'accounts.x.ai' &&
    !host.endsWith('.x.ai')
  ) {
    throw new XaiOAuthError(
      `Refusing non-xAI OAuth ${field}: ${value}`,
      XaiErrorCode.DISCOVERY_INVALID_ORIGIN,
    );
  }
  return url.toString();
}

// ─── OIDC Discovery ──────────────────────────────────────────────────────────

async function discover(): Promise<XaiDiscovery> {
  let response: Response;
  try {
    response = await fetch(DISCOVERY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI OIDC discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  if (!response.ok) {
    throw new XaiOAuthError(
      `xAI OIDC discovery returned ${response.status}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI OIDC discovery returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      XaiErrorCode.DISCOVERY_FAILED,
    );
  }
  const authorizationEndpoint = validateEndpoint(
    String(payload.authorization_endpoint ?? ''),
    'authorization_endpoint',
  );
  const tokenEndpoint = validateEndpoint(String(payload.token_endpoint ?? ''), 'token_endpoint');
  const deviceAuthorizationEndpoint = payload.device_authorization_endpoint
    ? validateEndpoint(
        String(payload.device_authorization_endpoint),
        'device_authorization_endpoint',
      )
    : undefined;
  return {
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    ...(deviceAuthorizationEndpoint
      ? { device_authorization_endpoint: deviceAuthorizationEndpoint }
      : {}),
  };
}

// ─── Loopback callback server ────────────────────────────────────────────────

interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

function startCallbackServer(): Promise<{
  server: import('node:http').Server;
  redirectUri: string;
  waitForCallback: (timeoutMs: number) => Promise<CallbackResult>;
}> {
  let settle: ((value: CallbackResult) => void) | undefined;
  const callbackPromise = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });

  const server = createServer((req, res) => {
    try {
      const origin = req.headers.origin;
      if (origin === 'https://accounts.x.ai' || origin === 'https://auth.x.ai') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', `http://${CALLBACK_HOST}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const result: CallbackResult = {
        code: url.searchParams.get('code') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        error: url.searchParams.get('error') ?? undefined,
        errorDescription: url.searchParams.get('error_description') ?? undefined,
      };

      res.statusCode = result.error ? 400 : 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const html = result.error
        ? '<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>'
        : '<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>';
      res.end(html);
      settle?.(result);
    } catch {
      res.statusCode = 500;
      res.end('Internal error');
    }
  });

  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, CALLBACK_HOST, () => {
        server.removeListener('error', reject);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });

  return (async () => {
    let actualPort: number;
    try {
      actualPort = await listen(CALLBACK_PORT);
    } catch (firstError) {
      try {
        actualPort = await listen(0);
      } catch (secondError) {
        const errorDescription = `Could not bind xAI OAuth callback server on ${CALLBACK_HOST}:${CALLBACK_PORT} or an ephemeral port: ${secondError instanceof Error ? secondError.message : String(secondError)} (initial error: ${firstError instanceof Error ? firstError.message : String(firstError)})`;
        return {
          server,
          redirectUri: `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`,
          waitForCallback: async () => ({
            error: XaiErrorCode.CALLBACK_BIND_FAILED,
            errorDescription,
          }),
        };
      }
    }
    const redirectUri = `http://${CALLBACK_HOST}:${actualPort}${CALLBACK_PATH}`;
    return {
      server,
      redirectUri,
      waitForCallback: (timeoutMs: number) =>
        Promise.race([
          callbackPromise,
          new Promise<CallbackResult>((resolve) =>
            setTimeout(
              () =>
                resolve({
                  error: XaiErrorCode.CALLBACK_TIMEOUT,
                  errorDescription: 'Timed out waiting for xAI OAuth callback.',
                }),
              timeoutMs,
            ),
          ),
        ]),
    };
  })();
}

// ─── Token exchange ───────────────────────────────────────────────────────────

async function fetchTokenResponse(
  tokenEndpoint: string,
  body: URLSearchParams,
  errorCode: string,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: controller.signal,
    });
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI ${label} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      errorCode,
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function tokenResponseText(response: Response) {
  try {
    return await response.text();
  } catch (cause) {
    return `unable to read response body: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

async function tokenResponseJson(
  response: Response,
  errorCode: string,
  label: string,
): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch (cause) {
    throw new XaiOAuthError(
      `xAI ${label} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      errorCode,
    );
  }
}

async function tokenResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await tokenResponseText(response);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: `HTTP ${response.status}`, error_description: text };
  }
}

function credentialsFromLoginPayload(
  payload: Record<string, unknown>,
  tokenEndpoint: string,
  invalidCode: string,
  label: string,
): XaiOAuthCredentials {
  const access = String(payload.access_token ?? '');
  const refresh = String(payload.refresh_token ?? '');
  if (!access) {
    throw new XaiOAuthError(`xAI ${label} did not return access_token.`, invalidCode);
  }
  if (!refresh) {
    throw new XaiOAuthError(`xAI ${label} did not return refresh_token.`, invalidCode);
  }
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : Number(payload.expires_in ?? 3600);
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    tokenEndpoint,
    discovery: { authorization_endpoint: '', token_endpoint: tokenEndpoint },
    idToken: String(payload.id_token ?? ''),
    tokenType: String(payload.token_type ?? 'Bearer'),
    baseUrl: getBaseUrl(),
  };
}

async function exchangeCode(
  tokenEndpoint: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<XaiOAuthCredentials> {
  const response = await fetchTokenResponse(
    tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    XaiErrorCode.TOKEN_EXCHANGE_FAILED,
    'token exchange',
  );
  if (!response.ok) {
    throw new XaiOAuthError(
      `xAI token exchange failed: ${response.status} ${await tokenResponseText(response)}`,
      XaiErrorCode.TOKEN_EXCHANGE_FAILED,
    );
  }
  return credentialsFromLoginPayload(
    await tokenResponseJson(response, XaiErrorCode.TOKEN_EXCHANGE_FAILED, 'token exchange'),
    tokenEndpoint,
    XaiErrorCode.TOKEN_EXCHANGE_INVALID,
    'token exchange',
  );
}

// ─── Device authorization ───────────────────────────────────────────────────

async function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Login cancelled');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('Login cancelled'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function readPositiveNumber(value: unknown, fallback: number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new XaiOAuthError(
      `xAI device authorization returned invalid ${field}.`,
      XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
    );
  }
  return parsed;
}

async function requestDeviceCode(deviceAuthorizationEndpoint: string) {
  const response = await fetchTokenResponse(
    deviceAuthorizationEndpoint,
    new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
    }),
    XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
    'device authorization',
  );
  if (!response.ok) {
    throw new XaiOAuthError(
      `xAI device authorization failed: ${response.status} ${await tokenResponseText(response)}`,
      XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
    );
  }
  const payload = await tokenResponseJson(
    response,
    XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
    'device authorization',
  );
  const deviceCode = String(payload.device_code ?? '');
  const userCode = String(payload.user_code ?? '');
  const verificationUri = String(
    payload.verification_uri_complete ?? payload.verification_uri ?? '',
  );
  if (!deviceCode || !userCode || !verificationUri) {
    throw new XaiOAuthError(
      'xAI device authorization did not return device_code, user_code, and verification_uri.',
      XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
    );
  }
  return {
    deviceCode,
    userCode,
    verificationUri: validateEndpoint(verificationUri, 'verification_uri'),
    intervalSeconds: readPositiveNumber(payload.interval, 5, 'interval'),
    expiresInSeconds: readPositiveNumber(payload.expires_in, 1800, 'expires_in'),
  };
}

async function loginWithDeviceCode(
  discovery: XaiDiscovery,
  callbacks: import('@earendil-works/pi-ai').OAuthLoginCallbacks,
): Promise<XaiOAuthCredentials> {
  if (!discovery.device_authorization_endpoint) {
    throw new XaiOAuthError(
      'xAI OIDC discovery did not include a device authorization endpoint.',
      XaiErrorCode.DEVICE_AUTHORIZATION_UNAVAILABLE,
    );
  }
  const onDeviceCode =
    typeof (callbacks as { onDeviceCode?: unknown }).onDeviceCode === 'function'
      ? callbacks.onDeviceCode
      : undefined;
  if (!onDeviceCode) {
    throw new XaiOAuthError(
      'xAI device authorization requires a device-code capable pi login UI.',
      XaiErrorCode.DEVICE_AUTHORIZATION_UNAVAILABLE,
    );
  }
  const device = await requestDeviceCode(discovery.device_authorization_endpoint);
  onDeviceCode({
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
  });
  callbacks.onProgress?.('Waiting for xAI device authorization...');

  const deadline = Date.now() + device.expiresInSeconds * 1000;
  const poll = async (intervalSeconds: number): Promise<XaiOAuthCredentials> => {
    if (Date.now() >= deadline) {
      throw new XaiOAuthError(
        'Timed out waiting for xAI device authorization.',
        XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      );
    }
    await sleep(intervalSeconds * 1000, callbacks.signal);
    const response = await fetchTokenResponse(
      discovery.token_endpoint,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
      }),
      XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      'device token exchange',
    );
    if (response.ok) {
      const credentials = credentialsFromLoginPayload(
        await tokenResponseJson(
          response,
          XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
          'device token exchange',
        ),
        discovery.token_endpoint,
        XaiErrorCode.DEVICE_AUTHORIZATION_INVALID,
        'device token exchange',
      );
      credentials.discovery = discovery;
      return credentials;
    }

    const payload = await tokenResponsePayload(response);
    if (payload.error === 'authorization_pending') return poll(intervalSeconds);
    if (payload.error === 'slow_down') return poll(intervalSeconds + 5);
    throw new XaiOAuthError(
      `xAI device authorization failed: ${response.status} ${String(
        payload.error_description ?? payload.error ?? 'unknown error',
      )}`,
      XaiErrorCode.DEVICE_AUTHORIZATION_FAILED,
      payload.error === 'access_denied' || payload.error === 'expired_token',
    );
  };

  return poll(Math.max(1, device.intervalSeconds));
}

async function loginWithBrowserCallback() {
  const { verifier, challenge } = await generatePKCE();
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const callback = await startCallbackServer();

  return { callback, challenge, nonce, state, verifier };
}

// ─── Login (called by pi's /login flow) ──────────────────────────────────────

export async function login(
  callbacks: import('@earendil-works/pi-ai').OAuthLoginCallbacks,
): Promise<import('@earendil-works/pi-ai').OAuthCredentials> {
  const discovery = await discover();
  const supportsDeviceLogin =
    discovery.device_authorization_endpoint &&
    typeof callbacks.onSelect === 'function' &&
    typeof (callbacks as { onDeviceCode?: unknown }).onDeviceCode === 'function';
  const method = supportsDeviceLogin
    ? await callbacks.onSelect({
        message: 'Select Grok CLI login method:',
        options: [
          { id: 'browser', label: 'Browser OAuth callback' },
          { id: 'device', label: 'Device code (SSH/headless)' },
        ],
      })
    : 'browser';
  if (!method) throw new Error('Login cancelled');
  if (method === 'device') return loginWithDeviceCode(discovery, callbacks);

  const browser = await loginWithBrowserCallback();
  try {
    const authUrl = new URL(discovery.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', browser.callback.redirectUri);
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('code_challenge', browser.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', browser.state);
    authUrl.searchParams.set('nonce', browser.nonce);
    authUrl.searchParams.set('plan', 'generic');
    authUrl.searchParams.set('referrer', 'pi-grok-cli');

    callbacks.onAuth({
      url: authUrl.toString(),
      instructions: `Authorize xAI, then return to pi. Callback listener: ${browser.callback.redirectUri}`,
    });

    const result = await browser.callback.waitForCallback(180_000);

    if (result.error) {
      const code =
        result.error === XaiErrorCode.CALLBACK_BIND_FAILED ||
        result.error === XaiErrorCode.CALLBACK_TIMEOUT
          ? result.error
          : XaiErrorCode.AUTHORIZATION_FAILED;
      throw new XaiOAuthError(result.errorDescription ?? result.error, code);
    }
    if (result.state !== browser.state) {
      throw new XaiOAuthError(
        'xAI OAuth state mismatch — possible CSRF.',
        XaiErrorCode.STATE_MISMATCH,
      );
    }
    if (!result.code) {
      throw new XaiOAuthError(
        'xAI OAuth callback did not include an authorization code.',
        XaiErrorCode.CODE_MISSING,
      );
    }

    const credentials = await exchangeCode(
      discovery.token_endpoint,
      result.code,
      browser.callback.redirectUri,
      browser.verifier,
    );
    credentials.discovery = discovery;
    return credentials;
  } finally {
    browser.callback.server.close();
  }
}

// ─── Token refresh ────────────────────────────────────────────────────────────

export async function refresh(
  credentials: import('@earendil-works/pi-ai').OAuthCredentials,
): Promise<import('@earendil-works/pi-ai').OAuthCredentials> {
  const xai = credentials as XaiOAuthCredentials;
  const tokenEndpoint =
    xai.tokenEndpoint || xai.discovery?.token_endpoint || (await discover()).token_endpoint;
  validateEndpoint(tokenEndpoint, 'token_endpoint');

  if (!credentials.refresh) {
    throw new XaiOAuthError(
      'Missing refresh_token. Re-login required.',
      XaiErrorCode.REFRESH_MISSING,
      true,
    );
  }

  const response = await fetchTokenResponse(
    tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: credentials.refresh,
    }),
    XaiErrorCode.REFRESH_FAILED,
    'token refresh',
  );

  if (!response.ok) {
    const isFatal = response.status === 400 || response.status === 401 || response.status === 403;
    throw new XaiOAuthError(
      `xAI token refresh failed: ${response.status} ${await tokenResponseText(response)}`,
      XaiErrorCode.REFRESH_FAILED,
      isFatal,
    );
  }

  const payload = await tokenResponseJson(response, XaiErrorCode.REFRESH_FAILED, 'token refresh');
  const access = String(payload.access_token ?? '');
  if (!access) {
    throw new XaiOAuthError(
      'xAI token refresh did not return access_token.',
      XaiErrorCode.REFRESH_FAILED,
      true,
    );
  }

  const refresh_new = String(payload.refresh_token ?? credentials.refresh);
  const expiresIn =
    typeof payload.expires_in === 'number'
      ? payload.expires_in
      : Number(payload.expires_in ?? 3600);

  return {
    ...xai,
    access,
    refresh: refresh_new,
    expires: Date.now() + expiresIn * 1000 - REFRESH_SKEW_MS,
    tokenEndpoint,
    idToken: String(payload.id_token ?? xai.idToken ?? ''),
    tokenType: String(payload.token_type ?? xai.tokenType ?? 'Bearer'),
    baseUrl: getBaseUrl(),
  };
}

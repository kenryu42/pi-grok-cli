import { once } from 'node:events';
import { createConnection } from 'node:net';
import {
  InMemoryCredentialStore,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  type ExtensionContext,
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/config.js';
import { registerAccountManagement } from '../../src/provider/accounts.js';
import {
  type AccountDashboardHandle,
  createAccountDashboard,
  startAccountDashboard,
} from '../../src/provider/dashboard/server.js';
import { oauthCredential, useTempHome } from '../vision/helpers.js';

const setupHome = useTempHome();
const dashboards: AccountDashboardHandle[] = [];

afterEach(async () => {
  await Promise.all(dashboards.splice(0).map((dashboard) => dashboard.close()));
  vi.restoreAllMocks();
});

async function setup() {
  setupHome();
  saveConfig(DEFAULT_CONFIG);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('grok-cli', async () => oauthCredential('personal'));
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const loginFlows = new Map<
    string,
    (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>
  >();
  const registerAccount = (account: { provider: string; label: string }) => {
    runtime.registerProvider(account.provider, {
      name: account.label,
      baseUrl: 'https://example.test',
      api: 'openai-responses',
      models: [
        {
          id: 'grok-build',
          name: 'Grok Build',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
      oauth: {
        name: account.label,
        usesCallbackServer: true,
        login: (callbacks) =>
          loginFlows.get(account.provider)?.(callbacks) ??
          Promise.reject(new Error('No test login flow registered.')),
        refreshToken: async (credential) => credential,
        getApiKey: (credential) => credential.access,
      },
    });
  };
  registerAccount({ provider: 'grok-cli', label: 'Account 1' });
  const modelRegistry = new ModelRegistry(runtime);
  const pi = {
    registerCommand: vi.fn(),
    setModel: vi.fn(async () => true),
    unregisterProvider: vi.fn((provider: string) => runtime.unregisterProvider(provider)),
  } as unknown as ExtensionAPI;
  const accountManagement = registerAccountManagement(pi, registerAccount);
  const ctx = {
    model: { provider: 'grok-cli', id: 'grok-build' },
    modelRegistry,
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
  return {
    accountManagement,
    credentials,
    ctx,
    loginFlows,
    pi,
    runtime,
    async setCredential(provider: string, credential: ReturnType<typeof oauthCredential>) {
      await credentials.modify(provider, async () => credential);
      await runtime.refresh({ allowNetwork: false });
    },
  };
}

async function bootstrap(dashboard: AccountDashboardHandle) {
  const response = await fetch(dashboard.bootstrapUrl, { redirect: 'manual' });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe('/');
  return response.headers.get('set-cookie')?.split(';')[0] ?? '';
}

const mutationHeaders = (dashboard: AccountDashboardHandle, cookie: string) => ({
  Cookie: cookie,
  Origin: dashboard.origin,
  'Content-Type': 'application/json',
  'X-Grok-CSRF': dashboard.csrfToken,
});

const servedFile = (session: Awaited<ReturnType<typeof openDashboard>>, path = '') =>
  fetch(`${session.dashboard.origin}${path}`, { headers: { Cookie: session.cookie } }).then(
    (response) => response.text(),
  );

async function openDashboard(options?: Parameters<typeof startAccountDashboard>[2]) {
  const extension = await setup();
  const dashboard = await startAccountDashboard(
    extension.accountManagement.manager,
    extension.ctx,
    options,
  );
  dashboards.push(dashboard);
  const cookie = await bootstrap(dashboard);
  return {
    extension,
    dashboard,
    cookie,
    headers: mutationHeaders(dashboard, cookie),
  };
}

async function openIncompleteMutation(session: Awaited<ReturnType<typeof openDashboard>>) {
  const url = new URL(session.dashboard.origin);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  await once(socket, 'connect');
  socket.write(
    [
      'POST /api/accounts HTTP/1.1',
      `Host: ${url.host}`,
      `Cookie: ${session.cookie}`,
      `Origin: ${session.dashboard.origin}`,
      'Content-Type: application/json',
      `X-Grok-CSRF: ${session.dashboard.csrfToken}`,
      'Content-Length: 100',
      '',
      '{',
    ].join('\r\n'),
  );
  return socket;
}

async function waitForAccount(
  dashboard: AccountDashboardHandle,
  cookie: string,
  provider: string,
  predicate: (account: Record<string, unknown>) => boolean,
) {
  await vi.waitFor(async () => {
    const state = (await (
      await fetch(`${dashboard.origin}/api/state`, { headers: { Cookie: cookie } })
    ).json()) as { accounts: Record<string, unknown>[] };
    expect(predicate(state.accounts.find((account) => account.provider === provider) ?? {})).toBe(
      true,
    );
  });
}

describe('account dashboard loopback server', () => {
  it('keeps simultaneous dashboard sessions isolated by cookie name', async () => {
    const first = await openDashboard();
    const second = await openDashboard();
    const cookies = `${first.cookie}; ${second.cookie}`;

    expect(first.cookie.split('=')[0]).not.toBe(second.cookie.split('=')[0]);
    expect(
      (await fetch(`${first.dashboard.origin}/api/state`, { headers: { Cookie: cookies } })).status,
    ).toBe(200);
    expect(
      (await fetch(`${second.dashboard.origin}/api/state`, { headers: { Cookie: cookies } }))
        .status,
    ).toBe(200);
  });

  it('requires its capability cookie and serves credential-free state with strict headers', async () => {
    const session = await openDashboard({ refreshAfterLogin: false });

    expect((await fetch(`${session.dashboard.origin}/api/state`)).status).toBe(401);
    const htmlError = await fetch(`${session.dashboard.origin}/`, {
      headers: { Accept: 'text/html' },
    });
    expect(htmlError.status).toBe(401);
    expect(htmlError.headers.get('content-type')).toContain('text/html');
    expect(await htmlError.text()).toContain('/grok-cli-accounts gui');
    const page = await fetch(session.dashboard.origin, {
      headers: { Cookie: session.cookie },
    });
    const state = await fetch(`${session.dashboard.origin}/api/state`, {
      headers: { Cookie: session.cookie },
    });

    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('Pi Grok CLI');
    expect(await state.json()).toMatchObject({
      accounts: [
        {
          provider: 'grok-cli',
          label: 'Account 1',
          authenticated: true,
          active: true,
        },
      ],
    });
    expect(
      JSON.stringify(
        await (
          await fetch(`${session.dashboard.origin}/api/state`, {
            headers: { Cookie: session.cookie },
          })
        ).json(),
      ),
    ).not.toContain('personal');
  });

  it('validates origin and csrf before applying account mutations', async () => {
    const session = await openDashboard();

    expect(
      (
        await fetch(`${session.dashboard.origin}/api/accounts`, {
          method: 'POST',
          headers: { ...session.headers, Origin: 'https://evil.example' },
          body: JSON.stringify({ label: 'Work' }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${session.dashboard.origin}/api/accounts`, {
          method: 'POST',
          headers: { ...session.headers, 'X-Grok-CSRF': 'wrong' },
          body: JSON.stringify({ label: 'Work' }),
        })
      ).status,
    ).toBe(403);

    const added = await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ label: ' Work ' }),
    });

    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ provider: 'grok-cli-2', label: 'Work' });
    expect(loadConfig().config.accounts.items.at(-1)).toEqual({
      provider: 'grok-cli-2',
      label: 'Work',
    });
  });

  it('accepts account routes for two-digit provider aliases', async () => {
    const session = await openDashboard();
    for (let account = 2; account <= 10; account += 1) {
      await fetch(`${session.dashboard.origin}/api/accounts`, {
        method: 'POST',
        headers: session.headers,
        body: JSON.stringify({ label: `Account ${account}` }),
      });
    }

    const renamed = await fetch(`${session.dashboard.origin}/api/accounts/grok-cli-10`, {
      method: 'PATCH',
      headers: session.headers,
      body: JSON.stringify({ label: 'Account ten' }),
    });

    expect(renamed.status).toBe(200);
    expect(loadConfig().config.accounts.items.at(-1)).toEqual({
      provider: 'grok-cli-10',
      label: 'Account ten',
    });
  });

  it('renames, activates, logs out, and removes accounts through the shared manager', async () => {
    const session = await openDashboard();
    await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ label: 'Work' }),
    });
    await session.extension.setCredential('grok-cli-2', oauthCredential('work'));

    const renamed = await fetch(`${session.dashboard.origin}/api/accounts/grok-cli-2`, {
      method: 'PATCH',
      headers: session.headers,
      body: JSON.stringify({ label: 'Client' }),
    });
    const activated = await fetch(`${session.dashboard.origin}/api/accounts/grok-cli-2/activate`, {
      method: 'POST',
      headers: session.headers,
      body: '{}',
    });
    const removed = await fetch(`${session.dashboard.origin}/api/accounts/grok-cli-2`, {
      method: 'DELETE',
      headers: session.headers,
      body: '{}',
    });
    const loggedOut = await fetch(`${session.dashboard.origin}/api/accounts/grok-cli/logout`, {
      method: 'POST',
      headers: session.headers,
      body: '{}',
    });

    expect(renamed.status).toBe(200);
    expect(activated.status).toBe(200);
    expect(session.extension.pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'grok-cli-2', id: 'grok-build' }),
    );
    expect(removed.status).toBe(200);
    expect(loggedOut.status).toBe(200);
    expect(loadConfig().config.accounts.items).toEqual([
      { provider: 'grok-cli', label: 'Account 1' },
    ]);
    expect(await session.extension.credentials.read('grok-cli')).toBeUndefined();
  });

  it('redirects browser login without exposing credentials and accepts manual codes', async () => {
    const session = await openDashboard({ refreshAfterLogin: false });
    await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ label: 'Work' }),
    });
    session.extension.loginFlows.set('grok-cli-2', async (callbacks) => {
      callbacks.onAuth({ url: 'https://accounts.x.ai/authorize?state=browser-state' });
      const code = await callbacks.onManualCodeInput?.();
      if (code !== 'manual-code') throw new Error('manual code rejected');
      return oauthCredential('dashboard-access');
    });

    const ticket = await fetch(`${session.dashboard.origin}/api/accounts/grok-cli-2/login-ticket`, {
      method: 'POST',
      headers: session.headers,
      body: '{}',
    });
    const path = ((await ticket.json()) as { path: string }).path;
    const redirect = await fetch(`${session.dashboard.origin}${path}`, {
      headers: { Cookie: session.cookie },
      redirect: 'manual',
    });

    expect(ticket.status).toBe(201);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(
      'https://accounts.x.ai/authorize?state=browser-state',
    );
    await fetch(`${session.dashboard.origin}/api/accounts/grok-cli-2/login-code`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ code: 'manual-code' }),
    });
    await waitForAccount(
      session.dashboard,
      session.cookie,
      'grok-cli-2',
      (account) => account.authenticated === true,
    );
    const state = await (
      await fetch(`${session.dashboard.origin}/api/state`, {
        headers: { Cookie: session.cookie },
      })
    ).text();

    expect(state).not.toContain('dashboard-access');
    expect(state).not.toContain('manual-code');
    expect(state).not.toContain('browser-state');
  });

  it('serves DOM-safe client code and rejects malformed or oversized mutations', async () => {
    const session = await openDashboard();
    const script = await servedFile(session, '/app.js');
    const malformed = await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: session.headers,
      body: '{',
    });
    const oversized = await fetch(`${session.dashboard.origin}/api/accounts`, {
      method: 'POST',
      headers: session.headers,
      body: JSON.stringify({ label: 'x'.repeat(9000) }),
    });

    expect(script).toContain('textContent');
    expect(script).not.toContain('innerHTML');
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it('serves an accessible page shell with brand-consistent client behavior', async () => {
    const session = await openDashboard();
    const page = await servedFile(session);
    const script = await servedFile(session, '/app.js');

    // The confirm button stays the dialog's default action (Enter submits, never cancels).
    expect(page).toContain('id="dialog-cancel" type="button"');
    // Failures are announced assertively; routine status stays polite.
    expect(page).toContain('role="alert"');
    expect(page).toContain('role="status"');
    // A persistent polite region carries login progress across poll-driven re-renders.
    expect(page).toContain('id="sr-status"');
    // The appbar separator is decorative and stays out of the accessibility tree.
    expect(page).toContain('class="brand-sep" aria-hidden="true"');
    // Card titles are h2s: the heading outline never skips a level under the h1 brand.
    expect(script).toContain("element('h2'");
    expect(script).not.toContain("element('h3'");
    // The favicon matches the in-app brand mark (ink glyph on a raised tile).
    expect(page).toContain('%23f7f8f8');
    expect(page).not.toContain('%234fd1e8');
    // Re-renders preserve keyboard focus and typed login codes.
    expect(script).toContain('data-action');
    expect(script).toContain('[data-provider]');
    // Entrance motion runs once instead of replaying on every poll.
    expect(script).toContain('settled');
    // Toasts pause their dismiss timer on hover.
    expect(script).toContain('pointerenter');
  });

  it('keeps long labels contained and offline text readable', async () => {
    const session = await openDashboard();
    const styles = await servedFile(session, '/app.css');

    // Long account labels truncate inside the card instead of overflowing the grid.
    expect(styles).toContain('.card-title-row h2');
    expect(styles).not.toContain('.card-title-row h3');
    expect(styles).toMatch(/\.card-title-row\s*\{[^}]*min-width:\s*0/);
    // Offline desaturation never dims text below AA contrast.
    expect(styles).toContain('filter: saturate(0.55)');
    expect(styles).not.toContain('brightness(0.82)');
    // Component rules derive status hues from tokens instead of repeating raw values.
    expect(styles).not.toMatch(/border-color: oklch\(0/);
    expect(styles).toContain('oklch(from var(--red)');
    expect(styles).toContain('oklch(from var(--amber)');
    expect(styles).toContain('oklch(from var(--accent)');
    expect(styles).not.toContain('.brand-meta::before');
  });

  it('confirms account operations and throttles the state field', async () => {
    const session = await openDashboard();
    const script = await servedFile(session, '/app.js');

    // Successful account operations confirm audibly, not only visually.
    expect(script).toContain(`Switched to \${account.label}.`);
    expect(script).toContain(`Renamed to \${updated.label}.`);
    expect(script).toContain(`Removed \${account.label}.`);
    expect(script).toContain(`Logged out \${account.label}.`);
    expect(script).toContain(`Logged in \${account.label}.`);
    // Hidden toasts clear their text so stale messages leave the accessibility tree.
    expect(script).toContain("node.textContent = ''");
    // The state field renders on its documented 30fps cadence and resizes via observer.
    expect(script).toContain('1000 / 30');
    expect(script).toContain('ResizeObserver');
  });

  it('reuses one server, reports browser-launch failures, and closes cleanly', async () => {
    const extension = await setup();
    const launchBrowser = vi.fn(async () => false);
    const dashboard = createAccountDashboard(extension.accountManagement.manager, {
      launchBrowser,
    });

    const first = await dashboard.open(extension.ctx);
    const second = await dashboard.open(extension.ctx);

    expect(second.origin).toBe(first.origin);
    expect(launchBrowser).toHaveBeenCalledTimes(2);
    expect(extension.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining(first.bootstrapUrl),
      'warning',
    );
    await dashboard.close();
    await expect(fetch(first.origin)).rejects.toThrow();
  });

  it('times out incomplete mutation request bodies', async () => {
    const session = await openDashboard({ bodyTimeoutMs: 20 });
    const socket = await openIncompleteMutation(session);
    const response = await Promise.race([
      once(socket, 'data').then(([data]) => data.toString()),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 100)),
    ]);
    const connectionClosed = await Promise.race([
      once(socket, 'close').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    socket.destroy();

    expect(response).toContain('408 Request Timeout');
    expect(connectionClosed).toBe(true);
  });

  it('closes promptly with an incomplete mutation request body', async () => {
    const session = await openDashboard();
    const socket = await openIncompleteMutation(session);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = session.dashboard.close();
    const closedPromptly = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    socket.destroy();
    await closing;

    expect(closedPromptly).toBe(true);
  });

  it('expires an abandoned server after its idle timeout', async () => {
    const extension = await setup();
    const dashboard = await startAccountDashboard(
      extension.accountManagement.manager,
      extension.ctx,
      { idleMs: 20 },
    );
    dashboards.push(dashboard);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(fetch(dashboard.origin)).rejects.toThrow();
  });
});

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
    expect(await page.text()).toContain('Grok accounts');
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
    const script = await (
      await fetch(`${session.dashboard.origin}/app.js`, {
        headers: { Cookie: session.cookie },
      })
    ).text();
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
    const page = await (
      await fetch(session.dashboard.origin, {
        headers: { Cookie: session.cookie },
      })
    ).text();
    const script = await (
      await fetch(`${session.dashboard.origin}/app.js`, {
        headers: { Cookie: session.cookie },
      })
    ).text();

    // The confirm button stays the dialog's default action (Enter submits, never cancels).
    expect(page).toContain('id="dialog-cancel" type="button"');
    // Failures are announced assertively; routine status stays polite.
    expect(page).toContain('role="alert"');
    expect(page).toContain('role="status"');
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

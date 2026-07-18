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
import {
  type HTMLDialogElement as BrowserDialog,
  type HTMLElement as BrowserElement,
  type HTMLInputElement as BrowserInput,
  Window,
} from 'happy-dom';
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

const accountState = (
  overrides: Record<string, unknown> = {},
  login: Record<string, unknown> = { state: 'idle' },
) => ({
  provider: 'grok-cli',
  label: 'Account 1',
  status: 'Logged in',
  authenticated: true,
  active: true,
  environment: false,
  login,
  ...overrides,
});

async function browserDashboard(
  session: Awaited<ReturnType<typeof openDashboard>>,
  states: { refreshing: boolean; accounts: ReturnType<typeof accountState>[] }[],
  mutate: (path: string, method: string, body: Record<string, unknown>) => unknown = () => ({}),
  webgl = false,
) {
  const [page, styles, script] = await Promise.all([
    servedFile(session),
    servedFile(session, '/app.css'),
    servedFile(session, '/app.js'),
  ]);
  const window = new Window({ url: session.dashboard.origin });
  const timers = new Map<number, { callback: TimerHandler; delay: number }>();
  const frames = new Map<number, FrameRequestCallback>();
  const resizeCallbacks: ResizeObserverCallback[] = [];
  let timerId = 0;
  let frameId = 0;
  let stateIndex = 0;
  let canvasWidth = 800;
  let canvasHeight = 600;
  const drawArrays = vi.fn();
  const viewport = vi.fn();
  const animations = vi.fn(() => ({ cancel() {} }));

  Object.assign(window, {
    fetch: vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
      const url = new URL(String(input), session.dashboard.origin);
      if (url.pathname === '/api/state') {
        const state = states[Math.min(stateIndex, states.length - 1)];
        stateIndex += 1;
        return Response.json(state);
      }
      return Response.json(
        mutate(
          url.pathname,
          options.method ?? 'GET',
          options.body ? JSON.parse(String(options.body)) : {},
        ),
      );
    }),
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    open: () => window,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    ResizeObserver: class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    setTimeout: (callback: TimerHandler, delay = 0) => {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  Object.defineProperties(window.HTMLCanvasElement.prototype, {
    clientWidth: { configurable: true, get: () => canvasWidth },
    clientHeight: { configurable: true, get: () => canvasHeight },
  });
  Object.defineProperty(window.performance, 'now', { configurable: true, value: () => 0 });
  window.HTMLCanvasElement.prototype.getContext = vi.fn(() =>
    webgl
      ? {
          ARRAY_BUFFER: 1,
          COMPILE_STATUS: 1,
          FLOAT: 1,
          FRAGMENT_SHADER: 1,
          LINK_STATUS: 1,
          STATIC_DRAW: 1,
          TRIANGLES: 1,
          VERTEX_SHADER: 1,
          attachShader() {},
          bindBuffer() {},
          bufferData() {},
          compileShader() {},
          createBuffer: () => ({}),
          createProgram: () => ({}),
          createShader: () => ({}),
          drawArrays,
          enableVertexAttribArray() {},
          getProgramParameter: () => true,
          getShaderParameter: () => true,
          getUniformLocation: () => ({}),
          linkProgram() {},
          shaderSource() {},
          uniform1f() {},
          uniform2f() {},
          useProgram() {},
          vertexAttribPointer() {},
          viewport,
        }
      : null,
  ) as typeof window.HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(window.Element.prototype, 'animate', {
    configurable: true,
    value: animations,
  });
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function (returnValue = '') {
    this.returnValue = returnValue;
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
  };
  window.document.write(
    page
      .replace('<link rel="stylesheet" href="/app.css" />', `<style>${styles}</style>`)
      .replace('<script type="module" src="/app.js"></script>', ''),
  );
  window.eval(script);
  await vi.waitFor(() => expect(window.document.querySelector('.account-card')).not.toBeNull());

  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    animations,
    drawArrays,
    resizeCallbacks,
    viewport,
    window,
    async close() {
      await window.happyDOM.abort();
    },
    async runFrame(now: number) {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined;
      if (!next) return;
      frames.delete(next[0]);
      next[1](now);
      await flush();
    },
    async runTimers(delay: number) {
      const pending = [...timers].filter(([, timer]) => timer.delay === delay);
      for (const [id, timer] of pending) {
        timers.delete(id);
        if (typeof timer.callback === 'function') timer.callback();
      }
      await flush();
    },
    resize(width: number, height: number) {
      canvasWidth = width;
      canvasHeight = height;
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
    },
  };
}

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

  it('rejects malformed or oversized mutations', async () => {
    const session = await openDashboard();
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

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it('renders safely, preserves focused login input, and announces login progress', async () => {
    const session = await openDashboard();
    const malicious = '<img src=x onerror=alert(1)>';
    const browser = await browserDashboard(session, [
      {
        refreshing: false,
        accounts: [
          accountState(
            { label: malicious },
            { state: 'pending', progress: 'Waiting for browser authorization…' },
          ),
        ],
      },
      {
        refreshing: false,
        accounts: [
          accountState({ label: malicious }, { state: 'pending', progress: 'Enter code' }),
        ],
      },
      {
        refreshing: false,
        accounts: [accountState({ label: malicious }, { state: 'success' })],
      },
    ]);
    const document = browser.window.document;
    const code = document.querySelector('input[name="code"]') as unknown as BrowserInput;

    expect(document.querySelector('.card-title-row h2')?.textContent).toBe(malicious);
    expect(document.querySelector('.card-title-row img')).toBeNull();
    expect(document.querySelector('#dialog-cancel')?.getAttribute('type')).toBe('button');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(2);
    expect(document.querySelector('.brand-sep')?.getAttribute('aria-hidden')).toBe('true');
    code.value = 'keep-me';
    code.focus();

    await browser.runTimers(2000);
    await vi.waitFor(() =>
      expect(document.querySelector('#sr-status')?.textContent).toBe('Enter code'),
    );

    const rerenderedCode = document.querySelector('input[name="code"]') as unknown as BrowserInput;
    expect(rerenderedCode.value).toBe('keep-me');
    expect(document.activeElement).toBe(rerenderedCode);
    expect(document.querySelector('#accounts')?.classList.contains('settled')).toBe(true);
    expect(browser.animations).toHaveBeenCalledOnce();

    await browser.runTimers(2000);

    const toast = document.querySelector('#toast') as unknown as BrowserElement;
    await vi.waitFor(() => expect(toast.textContent).toBe(`Logged in ${malicious}.`));
    expect(toast.classList.contains('visible')).toBe(true);
    toast.dispatchEvent(new browser.window.Event('pointerenter'));
    await browser.runTimers(4800);
    expect(toast.classList.contains('visible')).toBe(true);
    toast.dispatchEvent(new browser.window.Event('pointerleave'));
    await browser.runTimers(2500);
    expect(toast.classList.contains('visible')).toBe(false);
    await browser.runTimers(400);
    expect(toast.textContent).toBe('');
    await browser.close();
  });

  it('applies label containment and preserves text contrast while offline', async () => {
    const session = await openDashboard();
    const browser = await browserDashboard(session, [
      {
        refreshing: false,
        accounts: [accountState({ label: 'A'.repeat(200) })],
      },
    ]);
    const document = browser.window.document;
    const titleRow = document.querySelector('.card-title-row');
    const title = document.querySelector('.card-title-row h2');
    const main = document.querySelector('main');
    if (!titleRow || !title || !main) throw new Error('Dashboard content did not render.');

    expect(browser.window.getComputedStyle(titleRow).minWidth).toBe('0');
    expect(browser.window.getComputedStyle(title).overflow).toBe('hidden');
    expect(browser.window.getComputedStyle(title).textOverflow).toBe('ellipsis');
    expect(browser.window.getComputedStyle(title).whiteSpace).toBe('nowrap');
    document.querySelector('#link-state')?.classList.add('error');
    const offlineRule = [...document.styleSheets[0].cssRules].find(
      (rule) => 'selectorText' in rule && rule.selectorText === 'body:has(.link-pill.error) main',
    ) as unknown as { selectorText: string; style: { filter: string } };
    expect(document.querySelector(offlineRule.selectorText)).toBe(main);
    expect(offlineRule.style.filter).toBe('saturate(0.55)');
    expect(offlineRule.style.filter).not.toContain('brightness');
    await browser.close();
  });

  it('confirms switch, rename, removal, and logout operations', async () => {
    const session = await openDashboard();
    const cases = [
      {
        button: 'Switch',
        initial: accountState({ active: false, label: 'Work', provider: 'grok-cli-2' }),
        next: accountState({ label: 'Work', provider: 'grok-cli-2' }),
        toast: 'Switched to Work.',
      },
      {
        button: 'Rename',
        initial: accountState({ label: 'Work', provider: 'grok-cli-2' }),
        next: accountState({ label: 'Renamed', provider: 'grok-cli-2' }),
        response: { label: 'Renamed' },
        value: 'Renamed',
        toast: 'Renamed to Renamed.',
      },
      {
        button: 'Remove',
        initial: accountState({ active: false, label: 'Work', provider: 'grok-cli-2' }),
        next: undefined,
        toast: 'Removed Work.',
      },
      {
        button: 'Log out',
        initial: accountState({ label: 'Personal' }),
        next: accountState({
          authenticated: false,
          active: false,
          label: 'Personal',
          status: 'Login required',
        }),
        toast: 'Logged out Personal.',
      },
    ];

    for (const operation of cases) {
      const browser = await browserDashboard(
        session,
        [
          { refreshing: false, accounts: [operation.initial] },
          { refreshing: false, accounts: operation.next ? [operation.next] : [] },
        ],
        () => operation.response ?? {},
      );
      const button = [...browser.window.document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === operation.button,
      );
      button?.click();
      if (operation.value) {
        const input = browser.window.document.querySelector(
          '#dialog-input',
        ) as unknown as BrowserInput;
        input.value = operation.value;
        (browser.window.document.querySelector('#action-dialog') as unknown as BrowserDialog).close(
          'confirm',
        );
      } else if (operation.button === 'Remove' || operation.button === 'Log out') {
        (browser.window.document.querySelector('#action-dialog') as unknown as BrowserDialog).close(
          'confirm',
        );
      }
      await vi.waitFor(() =>
        expect(browser.window.document.querySelector('#toast')?.textContent).toBe(operation.toast),
      );
      await browser.close();
    }
  });

  it('throttles state-field drawing and resizes through ResizeObserver', async () => {
    const session = await openDashboard();
    const browser = await browserDashboard(
      session,
      [{ refreshing: false, accounts: [accountState()] }],
      undefined,
      true,
    );

    expect(browser.resizeCallbacks).toHaveLength(1);
    expect(browser.viewport).toHaveBeenLastCalledWith(0, 0, 400, 300);
    await browser.runFrame(10);
    await browser.runFrame(20);
    expect(browser.drawArrays).not.toHaveBeenCalled();
    await browser.runFrame(40);
    expect(browser.drawArrays).toHaveBeenCalledOnce();
    browser.resize(1000, 500);
    expect(browser.viewport).toHaveBeenLastCalledWith(0, 0, 500, 250);
    await browser.close();
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

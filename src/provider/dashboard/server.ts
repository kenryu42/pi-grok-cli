import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AccountManager } from '../accounts.js';

const HOST = '127.0.0.1';
const COOKIE_PREFIX = 'grok_cli_dashboard_';
const MAX_BODY_BYTES = 8 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_MS = 15 * 60_000;
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AccountDashboardHandle {
  origin: string;
  bootstrapUrl: string;
  csrfToken: string;
  isOpen(): boolean;
  close(): Promise<void>;
}

interface DashboardOptions {
  bodyTimeoutMs?: number;
  idleMs?: number;
  refreshAfterLogin?: boolean;
}

interface AccountDashboardOptions extends DashboardOptions {
  launchBrowser?: (url: string) => Promise<boolean>;
}

type LoginState = 'pending' | 'success' | 'failed' | 'cancelled';

interface LoginJob {
  controller: AbortController;
  state: LoginState;
  progress?: string;
  error?: string;
  quotaError?: string;
  resolveManualCode: (code: string) => void;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(req: IncomingMessage, cookieName: string) {
  return req.headers.cookie
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([name]) => name === cookieName)?.[1];
}

function send(res: ServerResponse, status: number, body = '', contentType = 'text/plain') {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': `${contentType}; charset=utf-8`,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown) {
  send(res, status, JSON.stringify(value), 'application/json');
}

function readJson(req: IncomingMessage, timeoutMs: number) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected application/json.');
  }
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (keepErrorListener = false) => {
      if (timer) clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      if (!keepErrorListener) req.removeListener('error', onError);
    };
    const fail = (error: unknown) => {
      cleanup(true);
      req.once('close', () => req.removeListener('error', onError));
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        fail(new HttpError(413, 'Request body is too large.'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'));
      }
    };
    const onAborted = () => fail(new HttpError(400, 'Request body was interrupted.'));
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    timer = setTimeout(() => fail(new HttpError(408, 'Request body timed out.')), timeoutMs);
    timer.unref();
  });
}

function objectBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function publicError(error: unknown) {
  if (!(error instanceof Error)) return 'The dashboard action failed.';
  return error.message.replace(/https?:\/\/\S+/g, '[redacted URL]').slice(0, 240);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function accountId(pathname: string, suffix = '') {
  const match = new RegExp(`^/api/accounts/([A-Za-z0-9-]+)${suffix}$`).exec(pathname);
  return match?.[1];
}

function trustedAuthorizationUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    (hostname !== 'x.ai' &&
      hostname !== 'accounts.x.ai' &&
      hostname !== 'auth.x.ai' &&
      !hostname.endsWith('.x.ai'))
  ) {
    throw new Error('Login blocked — the authorization URL was not a trusted x.ai address.');
  }
  return url.toString();
}

function launchBrowser(target: string) {
  const command: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', target]]
        : ['xdg-open', [target]];
  return new Promise<boolean>((resolve) => {
    const child = spawn(command[0], command[1], {
      detached: true,
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('spawn', () => finish(true));
    child.once('error', () => finish(false));
    child.unref();
  });
}

export function createAccountDashboard(
  manager: AccountManager,
  options: AccountDashboardOptions = {},
) {
  let dashboard: AccountDashboardHandle | undefined;
  return {
    async open(ctx: ExtensionContext) {
      if (!dashboard?.isOpen()) {
        dashboard = await startAccountDashboard(manager, ctx, options);
      }
      if (!(await (options.launchBrowser ?? launchBrowser)(dashboard.bootstrapUrl))) {
        ctx.ui.notify(
          `Could not open the account dashboard automatically. Open this private local URL (do not share it): ${dashboard.bootstrapUrl}`,
          'warning',
        );
      }
      return dashboard;
    },
    async close() {
      await dashboard?.close();
      dashboard = undefined;
    },
  };
}

export async function startAccountDashboard(
  manager: AccountManager,
  ctx: ExtensionContext,
  options: DashboardOptions = {},
): Promise<AccountDashboardHandle> {
  const capability = randomBytes(32).toString('base64url');
  const cookieName = `${COOKIE_PREFIX}${randomBytes(8).toString('hex')}`;
  const csrfToken = randomBytes(32).toString('base64url');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace(
    '__GROK_CSRF_TOKEN__',
    csrfToken,
  );
  const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
  const javascript = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  let origin = '';
  let expectedHost = '';
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closing: Promise<void> | undefined;
  let refreshController: AbortController | undefined;
  const loginTickets = new Map<string, { accountId: string; expiresAt: number }>();
  const loginJobs = new Map<string, LoginJob>();
  const newAccountRevisions = new Map<string, number>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 408 || status === 413) res.shouldKeepAlive = false;
      if (req.headers.accept?.includes('text/html')) {
        send(
          res,
          status,
          `<!doctype html><title>Pi Grok CLI</title><h1>Pi Grok CLI</h1><p>${escapeHtml(publicError(error))}</p>`,
          'text/html',
        );
        return;
      }
      json(res, status, { error: publicError(error) });
    });
  });

  const close = () => {
    if (closing) return closing;
    if (idleTimer) clearTimeout(idleTimer);
    refreshController?.abort();
    for (const job of loginJobs.values()) {
      if (job.state === 'pending') job.controller.abort();
      job.resolveManualCode('');
    }
    closing = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close(), options.idleMs ?? DEFAULT_IDLE_MS);
    idleTimer.unref();
  };

  const requireMutation = (req: IncomingMessage) => {
    if (req.headers.origin !== origin || req.headers['x-grok-csrf'] !== csrfToken) {
      throw new HttpError(
        403,
        'The dashboard rejected this request — reload the page and try again.',
      );
    }
  };

  const state = () => {
    const snapshot = manager.snapshot(ctx);
    return {
      refreshing: Boolean(refreshController),
      connected: snapshot.connected,
      accounts: snapshot.accounts.map((account) => {
        const job = loginJobs.get(account.id);
        return {
          ...account,
          login: job
            ? {
                state: job.state,
                ...(job.progress ? { progress: job.progress } : {}),
                ...(job.error ? { error: job.error } : {}),
                ...(job.quotaError ? { quotaError: job.quotaError } : {}),
              }
            : { state: 'idle' },
        };
      }),
    };
  };

  const startLogin = async (id: string, res: ServerResponse) => {
    const account = manager.snapshot(ctx).accounts.find((candidate) => candidate.id === id);
    if (!account) throw new HttpError(404, 'Account not found — it may have been removed.');
    if (account.environment) {
      throw new HttpError(
        409,
        'This account logs in with the GROK_CLI_OAUTH_TOKEN environment variable.',
      );
    }
    if (loginJobs.get(id)?.state === 'pending') {
      throw new HttpError(409, 'A login is already in progress for this account.');
    }
    const removeOnFailureRevision = newAccountRevisions.get(id);
    const controller = new AbortController();
    let resolveManualCode = (_code: string) => {};
    const manualCode = new Promise<string>((resolve) => {
      resolveManualCode = resolve;
    });
    const job: LoginJob = {
      controller,
      state: 'pending',
      progress: 'Waiting for xAI authorization',
      resolveManualCode,
    };
    loginJobs.set(id, job);
    let settledRedirect = false;
    let finishRedirect = () => {};
    const redirected = new Promise<void>((resolve) => {
      finishRedirect = resolve;
    });
    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify(event) {
        if (event.type === 'progress' || event.type === 'info') {
          job.progress = publicError(new Error(event.message));
          return;
        }
        if (event.type === 'device_code') {
          throw new Error('Device-code login is not available in the dashboard — use the pi TUI.');
        }
        const location = trustedAuthorizationUrl(event.url);
        settledRedirect = true;
        res.writeHead(302, { ...SECURITY_HEADERS, Location: location });
        res.end();
        finishRedirect();
      },
      async prompt(prompt) {
        if (prompt.type === 'manual_code') return manualCode;
        if (prompt.type === 'select') return 'browser';
        throw new Error('Interactive OAuth prompts are not supported in the dashboard.');
      },
    };
    void manager.login(ctx, id, interaction).then(
      async () => {
        newAccountRevisions.delete(id);
        job.state = 'success';
        job.progress = 'Login complete';
        job.resolveManualCode('');
        if (options.refreshAfterLogin === false) return;
        try {
          const result = await manager.refreshOne(ctx, id, controller.signal);
          if (result.failed.length) job.quotaError = 'Login succeeded, but quota refresh failed.';
        } catch {
          job.quotaError = 'Login succeeded, but quota refresh failed.';
        }
      },
      async (error: unknown) => {
        job.state = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = controller.signal.aborted ? 'Login cancelled.' : publicError(error);
        job.resolveManualCode('');
        if (removeOnFailureRevision !== undefined && !controller.signal.aborted) {
          newAccountRevisions.delete(id);
          await manager.remove(ctx, id, removeOnFailureRevision).catch(() => undefined);
        }
        if (!settledRedirect) {
          send(
            res,
            502,
            '<!doctype html><title>Login failed</title><h1>Grok login failed</h1><p>You can close this window and retry from the dashboard.</p>',
            'text/html',
          );
          finishRedirect();
        }
      },
    );
    await redirected;
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    touch();
    if (req.headers.host !== expectedHost) throw new HttpError(421, 'Invalid dashboard host.');
    const url = new URL(req.url ?? '/', origin);
    if (req.method === 'GET' && url.pathname === `/bootstrap/${capability}`) {
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location: '/',
        'Set-Cookie': `${cookieName}=${capability}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end();
      return;
    }
    if (!safeEqual(cookieValue(req, cookieName) ?? '', capability)) {
      throw new HttpError(
        401,
        'Dashboard session expired — reopen it with /grok-cli-accounts gui.',
      );
    }
    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, html, 'text/html');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/app.css') {
      send(res, 200, css, 'text/css');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      send(res, 200, javascript, 'text/javascript');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      json(res, 200, state());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts') {
      requireMutation(req);
      const body = objectBody(
        await readJson(req, options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS),
      );
      if (body.label !== undefined && typeof body.label !== 'string') {
        throw new HttpError(400, 'Account label must be text.');
      }
      const account = await manager.add(ctx, body.label ?? '');
      newAccountRevisions.set(account.id, account.revision);
      json(res, 201, account);
      return;
    }
    const renameId = accountId(url.pathname);
    if (req.method === 'PATCH' && renameId) {
      requireMutation(req);
      const body = objectBody(
        await readJson(req, options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS),
      );
      if (typeof body.label !== 'string') {
        throw new HttpError(400, 'Account label must be text.');
      }
      json(res, 200, await manager.rename(ctx, renameId, body.label));
      return;
    }
    const activateId = accountId(url.pathname, '/activate');
    if (req.method === 'POST' && activateId) {
      requireMutation(req);
      json(res, 200, await manager.activate(ctx, activateId));
      return;
    }
    const logoutId = accountId(url.pathname, '/logout');
    if (req.method === 'POST' && logoutId) {
      requireMutation(req);
      json(res, 200, await manager.logout(ctx, logoutId));
      return;
    }
    if (req.method === 'DELETE' && renameId) {
      requireMutation(req);
      newAccountRevisions.delete(renameId);
      json(res, 200, await manager.remove(ctx, renameId));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/quotas/refresh') {
      requireMutation(req);
      if (refreshController) throw new HttpError(409, 'A quota refresh is already running.');
      refreshController = new AbortController();
      try {
        json(res, 200, await manager.refresh(ctx, refreshController.signal));
      } finally {
        refreshController = undefined;
      }
      return;
    }
    const ticketId = accountId(url.pathname, '/login-ticket');
    if (req.method === 'POST' && ticketId) {
      requireMutation(req);
      const account = manager.snapshot(ctx).accounts.find((candidate) => candidate.id === ticketId);
      if (!account) throw new HttpError(404, 'Account not found — it may have been removed.');
      if (account.environment) {
        throw new HttpError(
          409,
          'This account logs in with the GROK_CLI_OAUTH_TOKEN environment variable.',
        );
      }
      const ticket = randomBytes(24).toString('base64url');
      loginTickets.set(ticket, { accountId: ticketId, expiresAt: Date.now() + 60_000 });
      json(res, 201, { path: `/oauth/${ticket}` });
      return;
    }
    const ticket = /^\/oauth\/([A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (req.method === 'GET' && ticket) {
      const loginTicket = loginTickets.get(ticket);
      loginTickets.delete(ticket);
      if (!loginTicket || loginTicket.expiresAt < Date.now()) {
        throw new HttpError(404, 'Login link expired — start again from the dashboard.');
      }
      await startLogin(loginTicket.accountId, res);
      return;
    }
    const codeId = accountId(url.pathname, '/login-code');
    if (req.method === 'POST' && codeId) {
      requireMutation(req);
      const body = objectBody(
        await readJson(req, options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS),
      );
      if (typeof body.code !== 'string' || !body.code.trim()) {
        throw new HttpError(400, 'Authorization code is required.');
      }
      const job = loginJobs.get(codeId);
      if (job?.state !== 'pending') throw new HttpError(409, 'No login is waiting for a code.');
      job.resolveManualCode(body.code.trim());
      json(res, 202, { accepted: true });
      return;
    }
    const cancelId = accountId(url.pathname, '/login-cancel');
    if (req.method === 'POST' && cancelId) {
      requireMutation(req);
      const job = loginJobs.get(cancelId);
      if (job?.state !== 'pending') throw new HttpError(409, 'No login is running.');
      job.controller.abort();
      job.resolveManualCode('');
      json(res, 202, { cancelled: true });
      return;
    }
    throw new HttpError(404, 'Dashboard route not found.');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('Could not determine the dashboard address.');
  }
  expectedHost = `${HOST}:${address.port}`;
  origin = `http://${expectedHost}`;
  server.unref();
  touch();

  return {
    origin,
    bootstrapUrl: `${origin}/bootstrap/${capability}`,
    csrfToken,
    isOpen: () => server.listening,
    close,
  };
}

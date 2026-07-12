import packageJson from '../../package.json';
import { GROK_CLI_VERSION } from '../provider/stream.js';
import { normalizeAspectRatio } from './aspect.js';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;

function timeoutSignal(parent?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('request timed out')),
    REQUEST_TIMEOUT_MS,
  );
  const abort = () => controller.abort(parent?.reason ?? new Error('request cancelled'));
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (!signal) return;
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error('Imagine request was cancelled'));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
  });
}

function retryable(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function errorDetail(response: Response) {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string };
    return json.error?.message ?? json.message ?? text;
  } catch {
    return text;
  }
}

function httpError(status: number, detail: string) {
  const suffix = detail ? `: ${detail.slice(0, 500)}` : '';
  if (status === 401 || status === 403) {
    return `Imagine rejected the API key (HTTP ${status}). Re-run /login grok-cli or set GROK_CLI_OAUTH_TOKEN${suffix}`;
  }
  if (status === 400) return `Imagine rejected the request (HTTP 400)${suffix}`;
  if (status === 429)
    return `Imagine rate limited the request (HTTP 429). Try again later${suffix}`;
  if (status >= 500)
    return `Imagine service error (HTTP ${status}) after automatic retries${suffix}`;
  return `Imagine request failed (HTTP ${status})${suffix}`;
}

function fetchError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/i.test(message)) return 'Imagine request timed out after 60s';
  if (/cancelled|aborted/i.test(message)) return 'Imagine request was cancelled';
  return `Imagine network request failed: ${message}`;
}

async function requestWithRetry(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const timeout = timeoutSignal(init.signal ?? undefined);
    try {
      const response = await fetchImpl(url, { ...init, signal: timeout.signal });
      if (response.ok) return response;
      const detail = await errorDetail(response);
      if (!retryable(response.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(httpError(response.status, detail));
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Imagine ')) throw error;
      if (attempt === MAX_ATTEMPTS || init.signal?.aborted) throw new Error(fetchError(error));
    } finally {
      timeout.cleanup();
    }
    await delay(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), init.signal ?? undefined);
  }
  throw new Error('Imagine request failed');
}

export async function generateImage(options: {
  token: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  baseUrl?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}) {
  const response = await requestWithRetry(
    options.fetchImpl ?? fetch,
    `${(options.baseUrl ?? process.env.PI_GROK_CLI_IMAGINE_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/+$/, '')}/images/generations`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': `pi-grok-cli/${packageJson.version}`,
        'x-grok-client-version': GROK_CLI_VERSION,
      },
      body: JSON.stringify({
        model: process.env.PI_GROK_CLI_IMAGINE_MODEL ?? 'grok-imagine-image-quality',
        prompt: options.prompt,
        n: 1,
        aspect_ratio: normalizeAspectRatio(options.aspectRatio),
        resolution: options.resolution ?? '1k',
        response_format: 'b64_json',
      }),
      signal: options.signal,
    },
  );
  const json = (await response.json()) as { data?: { b64_json?: unknown }[] };
  const b64 = json.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64)
    throw new Error('Imagine returned a malformed response: missing image data');
  return { b64, mimeType: 'image/jpeg' as const };
}

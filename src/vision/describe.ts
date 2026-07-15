import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import type { ExtensionContext, ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { getBaseUrl } from '../auth/oauth.js';
import { loadConfig, type VisionConfig } from '../config.js';
import { resolveGrokToken } from '../provider/accounts.js';
import { grokCliModelHeaders } from '../provider/stream.js';
import {
  getCachePath,
  loadCache,
  makeCacheEntry,
  makeCacheKey,
  pruneCache,
  updateCache,
  type VisionImage,
} from './cache.js';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const DEFAULT_PROMPT =
  'Describe this image in detail. If it contains text, transcribe it exactly. ' +
  'If it shows code, reproduce it. If it shows a UI, describe layout and elements. ' +
  'Respond in the same language as any text in the image.';

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function createTimeoutSignal(parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('request timed out')),
    REQUEST_TIMEOUT_MS,
  );

  const onAbort = () => controller.abort(parent?.reason ?? new Error('request cancelled'));
  if (parent) {
    if (parent.aborted) onAbort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (!signal) return;

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('request cancelled'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  if (!text) return '';
  try {
    const json = JSON.parse(text);
    return json?.error?.message ?? json?.message ?? text;
  } catch {
    return text;
  }
}

function explainHttpError(status: number, body: string, model: string): string {
  const detail = body ? `: ${body.slice(0, 500)}` : '';
  if (status === 401 || status === 403) {
    return `Grok CLI rejected the API key (HTTP ${status}). Re-run /login grok-cli or set GROK_CLI_OAUTH_TOKEN${detail}`;
  }
  if (status === 400 || status === 404) {
    return `Grok CLI rejected model "${model}" (HTTP ${status})${detail}`;
  }
  if (status === 429) {
    return `Grok CLI rate limited the request (HTTP 429). Try again later${detail}`;
  }
  if (status >= 500) {
    return `Grok CLI service error (HTTP ${status}). Retried automatically; try again later if it persists${detail}`;
  }
  return `Grok CLI request failed (HTTP ${status})${detail}`;
}

function explainFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && (err.name === 'AbortError' || /timed out/i.test(message))) {
    return `Grok CLI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`;
  }
  if (/cancelled|aborted/i.test(message)) {
    return 'Grok CLI request was cancelled';
  }
  return `Grok CLI network request failed: ${message}`;
}

async function fetchWithRetry(url: string, init: RequestInit, model: string): Promise<Response> {
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { signal, cleanup } = createTimeoutSignal(init.signal ?? undefined);
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok || !isRetryableStatus(res.status) || attempt === MAX_ATTEMPTS) {
        return res;
      }
      lastError = explainHttpError(res.status, await readErrorBody(res), model);
    } catch (err) {
      lastError = explainFetchError(err);
      if (attempt === MAX_ATTEMPTS || /cancelled|aborted/i.test(lastError)) {
        throw new Error(`${lastError} after ${attempt} attempt${attempt === 1 ? '' : 's'}.`);
      }
    } finally {
      cleanup();
    }

    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), init.signal ?? undefined);
  }

  throw new Error(lastError ?? 'Grok CLI request failed.');
}

function extractDescription(json: unknown): string {
  const obj = asObject(json);
  if (!obj) return '';
  if (typeof obj.output_text === 'string' && obj.output_text.trim()) return obj.output_text;
  if (!Array.isArray(obj.output)) return '';

  return obj.output
    .map(asObject)
    .filter((o): o is Record<string, unknown> => o !== undefined && o.type === 'message')
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .map(asObject)
    .filter(
      (o): o is Record<string, unknown> =>
        o !== undefined && o.type === 'output_text' && typeof o.text === 'string',
    )
    .map((o) => o.text)
    .join('\n');
}

/** Describe a single image via the Grok CLI Responses endpoint. */
export async function describeImage(
  img: VisionImage,
  model: string,
  prompt: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${getBaseUrl()}/responses`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    ...grokCliModelHeaders(model),
    'x-grok-conv-id': `grok-cli-vision-${makeCacheKey(img, model, prompt).slice(0, 16)}`,
  };

  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              {
                type: 'input_image',
                image_url: `data:${img.mimeType};base64,${img.data}`,
                detail: 'auto',
              },
            ],
          },
        ],
        text: { format: { type: 'text' } },
        stream: false,
      }),
      signal,
    },
    model,
  );

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(explainHttpError(res.status, body, model));
  }

  const rawText = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Grok CLI returned non-JSON response: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const description = extractDescription(json);
  if (!description.trim()) {
    throw new Error('Grok CLI returned an empty description.');
  }
  return description;
}

function textContent(text: string): TextContent {
  return { type: 'text', text };
}

function replaceImagesWithText(
  content: (TextContent | ImageContent)[],
  replacements: TextContent[],
  skipped?: TextContent,
): TextContent[] {
  let imageIndex = 0;
  const parts = content.flatMap((part) => {
    if (part.type === 'text') return [part];

    const replacement = replacements[imageIndex];
    imageIndex += 1;
    return replacement ? [replacement] : [];
  });

  return skipped ? [...parts, skipped] : parts;
}

async function describeSingle(
  img: ImageContent,
  index: number,
  config: VisionConfig,
  cachePath: string,
  apiKey: string,
  ctx: ExtensionContext,
): Promise<string> {
  const visionImg: VisionImage = { data: img.data, mimeType: img.mimeType };
  const cacheKey = makeCacheKey(visionImg, config.model, DEFAULT_PROMPT);

  if (config.cacheEnabled) {
    const hit = loadCache(cachePath).entries[cacheKey];
    if (hit) return hit.description;
  }

  try {
    const description = await describeImage(
      visionImg,
      config.model,
      DEFAULT_PROMPT,
      apiKey,
      ctx.signal,
    );
    if (config.cacheEnabled) {
      await updateCache(cachePath, (cache) => {
        cache.entries[cacheKey] = makeCacheEntry(
          visionImg,
          config.model,
          DEFAULT_PROMPT,
          description,
        );
        pruneCache(cache, config.cacheMaxEntries);
      });
    }
    return description;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`[grok-cli-vision] description failed: ${msg}`, 'warning');
    return `[Image ${index + 1} — description unavailable: ${msg}]`;
  }
}

/**
 * Tool-result handler that routes images from `read` results through a Grok CLI
 * vision model when the active model is text-only. Returns text-only content to
 * replace the image so the text-only model can reason over the description.
 */
export async function handleReadResult(
  event: ToolResultEvent,
  ctx: ExtensionContext,
): Promise<{ content: TextContent[] } | undefined> {
  // Accept both the native `read` tool and the capital-`Read` Cursor shim,
  // which delegates to the native definition. Both return image blocks.
  if (event.toolName !== 'read' && event.toolName !== 'Read') return;

  // Route when the active model exists and does not declare image input. This
  // matches pi's own read tool (getNonVisionImageNote), which treats any model
  // whose input lacks "image" — including input:[] — as non-vision.
  const modelInput = ctx.model?.input;
  if (!modelInput || modelInput.includes('image')) return;

  const loaded = loadConfig();
  const config = loaded.config.vision;
  if (config.enabled === false) return;

  const images = event.content.filter((c): c is ImageContent => c.type === 'image');
  if (images.length === 0) return;

  const selected = images.slice(0, config.maxImages);
  const skipped = images.length - selected.length;

  const apiKey = await resolveGrokToken(ctx);
  if (!apiKey) {
    ctx.ui.notify(
      '[grok-cli-vision] No API key — run /login grok-cli or set GROK_CLI_OAUTH_TOKEN',
      'warning',
    );
    return {
      content: replaceImagesWithText(
        event.content,
        selected.map(() =>
          textContent('[grok-cli-vision: image not described — not authenticated]'),
        ),
        skipped > 0
          ? textContent(
              `[grok-cli-vision: ${skipped} additional image(s) omitted (maxImages=${config.maxImages}).]`,
            )
          : undefined,
      ),
    };
  }

  if (loaded.warning) ctx.ui.notify(`[grok-cli-vision] ${loaded.warning}`, 'warning');

  const cachePath = getCachePath();
  const descriptions = await Promise.all(
    selected.map((img, index) => describeSingle(img, index, config, cachePath, apiKey, ctx)),
  );

  const parts = descriptions.map((description, index) =>
    textContent(`[Image ${index + 1} — described by ${config.model}]\n${description}`),
  );
  return {
    content: replaceImagesWithText(
      event.content,
      parts,
      skipped > 0
        ? textContent(
            `[grok-cli-vision: ${skipped} additional image(s) omitted (maxImages=${config.maxImages}).]`,
          )
        : undefined,
    ),
  };
}

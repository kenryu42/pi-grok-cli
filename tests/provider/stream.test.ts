import type { Api, Context, Model } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

const { streamSimpleOpenAIResponses } = vi.hoisted(() => ({
  streamSimpleOpenAIResponses: vi.fn(
    (_model: unknown, _context: unknown, _options?: unknown) => ({}),
  ),
}));

vi.mock('@earendil-works/pi-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-ai')>()),
  streamSimpleOpenAIResponses,
}));

import { grokCliModelHeaders, streamGrokCli } from '../../src/provider/stream.js';

// User-Agent value the live inference endpoint accepts. Mirror of the
// open-grok-build opencode plugin; changing it here will break the 426 gate.
const EXPECTED_USER_AGENT = 'grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)';

function lastHeaders(): Record<string, string> {
  const options = streamSimpleOpenAIResponses.mock.calls.at(-1)?.[2] as
    | { headers: Record<string, string> }
    | undefined;
  return options?.headers ?? {};
}

const model = { id: 'grok-4', provider: 'grok-cli' } as Model<Api>;
const context = {} as Context;

function expectStaticHeaders(headers: Record<string, string>): void {
  expect(headers['User-Agent']).toBe(EXPECTED_USER_AGENT);
  expect(headers['x-grok-client-identifier']).toBe('grok-pager');
  expect(headers['x-grok-client-version']).toBe('0.2.91');
  expect(headers['x-xai-token-auth']).toBe('xai-grok-cli');
  expect(headers['x-grok-model-override']).toBe('grok-4');
}

describe('grokCliModelHeaders', () => {
  it('returns the static identification headers the version gate requires', () => {
    expectStaticHeaders(grokCliModelHeaders('grok-4'));
  });

  it('binds x-grok-model-override to the model id', () => {
    expect(grokCliModelHeaders('grok-build')['x-grok-model-override']).toBe('grok-build');
  });
});

describe('streamGrokCli', () => {
  it('sends the static headers plus the dynamic conversation id', () => {
    streamSimpleOpenAIResponses.mockClear();
    streamGrokCli(model, context, { sessionId: 'sess-123' });

    expectStaticHeaders(lastHeaders());
    expect(lastHeaders()['x-grok-conv-id']).toBe('sess-123');
  });

  it('omits the conversation id when there is no session id', () => {
    streamSimpleOpenAIResponses.mockClear();
    streamGrokCli(model, context, {});

    expect(lastHeaders()).not.toHaveProperty('x-grok-conv-id');
  });
});

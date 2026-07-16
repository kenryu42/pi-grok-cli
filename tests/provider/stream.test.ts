import { describe, expect, it } from 'vitest';
import { grokCliModelHeaders } from '../../src/provider/stream.js';

// User-Agent value the live inference endpoint accepts. Mirror of the
// open-grok-build opencode plugin; changing it here will break the 426 gate.
const EXPECTED_USER_AGENT = 'grok-pager/0.2.101 grok-shell/0.2.101 (macos; aarch64)';

function expectStaticHeaders(headers: Record<string, string>): void {
  expect(headers['User-Agent']).toBe(EXPECTED_USER_AGENT);
  expect(headers['x-grok-client-identifier']).toBe('grok-pager');
  expect(headers['x-grok-client-version']).toBe('0.2.101');
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

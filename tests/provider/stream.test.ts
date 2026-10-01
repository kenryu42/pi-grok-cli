import { afterEach, describe, expect, it, vi } from 'vitest';
import { grokCliModelHeaders, grokCliVersionHeaders } from '../../src/provider/stream.js';
import { startTestServer } from '../stateTestHelpers.js';

async function versionServer(status: number, body: string) {
  const paths: (string | undefined)[] = [];
  const server = await startTestServer((request, response) => {
    paths.push(request.url);
    response.writeHead(status, { 'Content-Type': 'text/plain' });
    response.end(body);
  });
  return { url: `${server.origin}/cli/stable`, paths, close: server.close };
}

async function resolveWith(url: string) {
  vi.stubEnv('PI_GROK_CLI_VERSION_URL', url);
  const { resolveGrokCliVersion } = await import('../../src/provider/stream.js');
  return resolveGrokCliVersion;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('Grok CLI identification headers', () => {
  it('identifies each model the way the official Grok CLI does', () => {
    expect(grokCliModelHeaders('grok-4')).toEqual({
      'x-grok-client-identifier': 'grok-shell',
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-model-override': 'grok-4',
    });
  });

  it('sends the version in the gate header and the official User-Agent format', () => {
    expect(grokCliVersionHeaders('1.0.46')).toEqual({
      'User-Agent': 'grok-shell/1.0.46 (macos; aarch64)',
      'x-grok-client-version': '1.0.46',
    });
  });
});

describe('resolveGrokCliVersion', () => {
  it('reads the latest stable release once per process', async () => {
    const server = await versionServer(200, '1.0.99\n');
    try {
      const resolveGrokCliVersion = await resolveWith(server.url);

      await expect(resolveGrokCliVersion()).resolves.toBe('1.0.99');
      await expect(resolveGrokCliVersion()).resolves.toBe('1.0.99');
      expect(server.paths).toEqual(['/cli/stable']);
    } finally {
      await server.close();
    }
  });

  it.each([
    { status: 500, body: 'unavailable' },
    { status: 200, body: '<html>not a version</html>' },
  ])('uses the bundled release when the stable pointer returns $status $body', async (reply) => {
    const server = await versionServer(reply.status, reply.body);
    try {
      await expect((await resolveWith(server.url))()).resolves.toBe('1.0.46');
    } finally {
      await server.close();
    }
  });

  it('uses the bundled release when the stable pointer is unreachable', async () => {
    const server = await versionServer(200, '1.0.99');
    await server.close();

    await expect((await resolveWith(server.url))()).resolves.toBe('1.0.46');
  });
});

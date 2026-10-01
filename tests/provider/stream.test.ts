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

// Serves the queued versions in order, one per lookup.
async function withVersionSequence(
  versions: string[],
  run: (stream: typeof import('../../src/provider/stream.js')) => Promise<void>,
) {
  const server = await startTestServer((_request, response) => response.end(versions.shift()));
  try {
    vi.stubEnv('PI_GROK_CLI_VERSION_URL', `${server.origin}/cli/stable`);
    await run(await import('../../src/provider/stream.js'));
  } finally {
    await server.close();
  }
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

  it('looks up the latest stable release again on refresh', async () => {
    const versions = ['1.0.99', '1.0.100'];
    await withVersionSequence(versions, async (stream) => {
      await expect(stream.resolveGrokCliVersion()).resolves.toBe('1.0.99');
      await expect(stream.refreshGrokCliVersion()).resolves.toBe('1.0.100');
      await expect(stream.resolveGrokCliVersion()).resolves.toBe('1.0.100');
    });
    expect(versions).toEqual([]);
  });

  it('shares one lookup between concurrent refreshes', async () => {
    const versions = ['1.0.99', '1.0.100', 'not a version'];
    await withVersionSequence(versions, async (stream) => {
      await stream.resolveGrokCliVersion();

      await expect(
        Promise.all([stream.refreshGrokCliVersion(), stream.refreshGrokCliVersion()]),
      ).resolves.toEqual(['1.0.100', '1.0.100']);
      await expect(stream.resolveGrokCliVersion()).resolves.toBe('1.0.100');
    });
    expect(versions).toEqual(['not a version']);
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

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseGrokCredentials, readGrokCredentials } from '../../src/auth/grokCredentials.js';

const entryKey = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const validEntry = {
  key: 'official-access',
  refresh_token: 'official-refresh',
  expires_at: '2030-01-02T03:04:05.000Z',
  oidc_issuer: 'https://auth.x.ai',
  oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828',
};
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe('official Grok CLI credentials', () => {
  it('normalizes the verified official credential entry', () => {
    expect(parseGrokCredentials({ [entryKey]: validEntry })).toEqual({
      access: 'official-access',
      refresh: 'official-refresh',
      expires: Date.parse('2030-01-02T03:04:05.000Z'),
      tokenEndpoint: 'https://auth.x.ai/oauth2/token',
      baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    });
  });

  it('accepts only unambiguous numeric millisecond and ISO string expiry values', () => {
    expect(
      parseGrokCredentials({
        [entryKey]: { ...validEntry, expires_at: 1_893_459_845_000 },
      })?.expires,
    ).toBe(1_893_459_845_000);
    expect(
      parseGrokCredentials({
        [entryKey]: { ...validEntry, expires_at: 1_893_459_845 },
      }),
    ).toBeUndefined();
    expect(
      parseGrokCredentials({
        [entryKey]: { ...validEntry, expires_at: '1893459845' },
      }),
    ).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    {},
    { access_token: validEntry },
    { [entryKey]: { ...validEntry, key: '' } },
    { [entryKey]: { ...validEntry, refresh_token: '' } },
    { [entryKey]: { ...validEntry, oidc_issuer: 'https://example.invalid' } },
    { [entryKey]: { ...validEntry, oidc_client_id: 'legacy-client' } },
  ])('ignores missing, incomplete, or unsupported data: %j', (value) => {
    expect(parseGrokCredentials(value)).toBeUndefined();
  });

  it('returns undefined for a missing or malformed auth file without exposing content', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-grok-credentials-'));
    process.env.HOME = home;
    await expect(readGrokCredentials()).resolves.toBeUndefined();

    await mkdir(join(home, '.grok'));
    await writeFile(join(home, '.grok', 'auth.json'), '{"secret":"not-json"');
    await expect(readGrokCredentials()).resolves.toBeUndefined();
  });

  it('reads the verified entry from ~/.grok/auth.json', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pi-grok-credentials-'));
    process.env.HOME = home;
    await mkdir(join(home, '.grok'));
    await writeFile(join(home, '.grok', 'auth.json'), JSON.stringify({ [entryKey]: validEntry }));
    await expect(readGrokCredentials()).resolves.toMatchObject({
      access: 'official-access',
      refresh: 'official-refresh',
    });
  });
});

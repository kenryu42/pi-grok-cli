import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateImage } from '../../src/imagine/generate.js';

afterEach(() => vi.useRealTimers());

describe('generateImage', () => {
  it('sends the captured Imagine request and returns JPEG base64', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ b64_json: '/9j/2Q==' }] }),
    );

    await expect(
      generateImage({ token: 'secret', prompt: 'a cat', aspectRatio: '16:9', fetchImpl }),
    ).resolves.toEqual({ b64: '/9j/2Q==', mimeType: 'image/jpeg' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.x.ai/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer secret',
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'pi-grok-cli/0.3.4',
          'x-grok-client-version': expect.any(String),
        }),
        body: JSON.stringify({
          model: 'grok-imagine-image-quality',
          prompt: 'a cat',
          n: 1,
          aspect_ratio: '16:9',
          resolution: '1k',
          response_format: 'b64_json',
        }),
      }),
    );
  });

  it('maps authorization and malformed response errors', async () => {
    await expect(
      generateImage({
        token: 'secret',
        prompt: 'cat',
        fetchImpl: async () => new Response('denied', { status: 401 }),
      }),
    ).rejects.toThrow('Re-run /login grok-cli');

    await expect(
      generateImage({
        token: 'secret',
        prompt: 'cat',
        fetchImpl: async () => Response.json({ data: [] }),
      }),
    ).rejects.toThrow('missing image data');
  });

  it('retries retryable responses up to three attempts', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [{ b64_json: '/9j/2Q==' }] }));
    const result = generateImage({ token: 'secret', prompt: 'cat', fetchImpl });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ b64: '/9j/2Q==', mimeType: 'image/jpeg' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

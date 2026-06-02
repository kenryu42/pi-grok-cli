import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizePayload } from '../../src/payload/sanitize.js';

describe('payload sanitization', () => {
  it('removes unsupported items and moves leading instructions', () => {
    const payload = sanitizePayload(
      {
        instructions: 'existing instruction',
        input: [
          { role: 'system', content: 'system instruction' },
          {
            role: 'developer',
            content: [
              { type: 'input_text', text: 'developer instruction' },
              { type: 'output_text', text: 'output text instruction' },
            ],
          },
          { type: 'reasoning', content: 'cached reasoning' },
          { role: 'user', content: '' },
          { role: 'user', content: 'hello' },
        ],
        include: ['reasoning.encrypted_content', 'message.output_text'],
        prompt_cache_retention: '24h',
        reasoning: { effort: 'minimal', summary: 'auto' },
        response_format: { type: 'json_object' },
      },
      'grok-4.3',
      'session-123',
    );

    expect(payload.instructions).toBe(
      'existing instruction\n\nsystem instruction\n\ndeveloper instruction\noutput text instruction',
    );
    expect(payload.input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(payload.include).toEqual(['message.output_text']);
    expect(payload.prompt_cache_retention).toBeUndefined();
    expect(payload.reasoning).toEqual({ effort: 'low' });
    expect(payload.text).toEqual({ format: { type: 'json_object' } });
    expect(payload.response_format).toBeUndefined();
    expect(payload.prompt_cache_key).toBe('session-123');
  });

  it('strips reasoning fields for models that do not accept reasoning effort', () => {
    const payload = sanitizePayload(
      {
        input: 'plain prompt',
        include: ['reasoning.encrypted_content'],
        reasoning: { effort: 'high' },
        reasoningEffort: 'high',
        prompt_cache_key: 'existing-session',
      },
      'grok-build',
      'new-session',
    );

    expect(payload.input).toBe('plain prompt');
    expect(payload.reasoning).toBeUndefined();
    expect(payload.reasoningEffort).toBeUndefined();
    expect(payload.include).toBeUndefined();
    expect(payload.prompt_cache_key).toBe('existing-session');
  });

  it('normalizes image parts and rewrites image tool output', () => {
    const payload = sanitizePayload(
      {
        input: [
          {
            role: 'user',
            content: [
              { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' },
              {
                type: 'image_url',
                image_url: {
                  url: 'https://example.invalid/image.png',
                  detail: 'high',
                },
              },
            ],
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: [
              { type: 'input_text', text: 'tool text' },
              { type: 'input_image', image_url: 'data:image/png;base64,aW1n' },
            ],
          },
        ],
      },
      'grok-composer-2.5-fast',
    );

    expect(payload.input).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,ZmFrZQ==',
            detail: 'auto',
          },
          {
            type: 'input_image',
            image_url: 'https://example.invalid/image.png',
            detail: 'high',
          },
        ],
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'tool text' },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'The previous tool result (call_1) included 1 image. Use the attached image as the visual output from that tool.',
          },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,aW1n',
            detail: 'auto',
          },
        ],
      },
    ]);
  });

  it('resolves local image paths to data URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-test-'));
    const imagePath = join(dir, 'sample image.png');
    writeFileSync(imagePath, Buffer.from('png image bytes'));

    try {
      const payload = sanitizePayload(
        {
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_image',
                  image_url: `'${imagePath}'`,
                },
              ],
            },
          ],
        },
        'grok-4.3',
      );

      expect(payload.input).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${Buffer.from('png image bytes').toString('base64')}`,
              detail: 'auto',
            },
          ],
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing or unsupported local images', () => {
    expect(() =>
      sanitizePayload(
        {
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: 'missing.png' }],
            },
          ],
        },
        'grok-4.3',
      ),
    ).toThrow('Image file does not exist or is not a valid URL: missing.png');
  });
});

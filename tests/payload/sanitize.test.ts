import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizePayload } from '../../src/payload/sanitize.js';

describe('payload sanitization', () => {
  it('removes unsupported items and moves all instructions', () => {
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
          { role: 'system', content: 'later system instruction' },
        ],
        include: ['reasoning.encrypted_content', 'message.output_text'],
        prompt_cache_retention: '24h',
        reasoning: { effort: 'minimal', summary: 'auto' },
        response_format: { type: 'json_object' },
      },
      'grok-4.3',
      'session-123',
      process.cwd(),
    );

    expect(payload.instructions).toBe(
      'existing instruction\n\nsystem instruction\n\ndeveloper instruction\noutput text instruction\n\nlater system instruction',
    );
    expect(payload.input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(payload.include).toEqual(['message.output_text']);
    expect(payload.prompt_cache_retention).toBeUndefined();
    expect(payload.reasoning).toEqual({ effort: 'low' });
    expect(payload.text).toEqual({ format: { type: 'json_object' } });
    expect(payload.response_format).toBeUndefined();
    expect(payload.prompt_cache_key).toBe('session-123');
  });

  it('preserves existing text while removing response_format', () => {
    const payload = sanitizePayload(
      {
        input: 'plain prompt',
        text: { format: { type: 'text' } },
        response_format: { type: 'json_object' },
      },
      'grok-4.3',
      undefined,
      process.cwd(),
    );

    expect(payload.text).toEqual({ format: { type: 'text' } });
    expect(payload.response_format).toBeUndefined();
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
      process.cwd(),
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
      undefined,
      process.cwd(),
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
        undefined,
        dir,
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

  it('resolves .jpg and .jpeg image paths to data URLs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-test-'));
    const jpgPath = join(dir, 'photo.jpg');
    const jpegPath = join(dir, 'photo.jpeg');
    writeFileSync(jpgPath, Buffer.from('jpg bytes'));
    writeFileSync(jpegPath, Buffer.from('jpeg bytes'));

    try {
      const jpgResult = sanitizePayload(
        {
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: jpgPath }],
            },
          ],
        },
        'grok-4.3',
        undefined,
        dir,
      );
      expect((jpgResult.input as Array<Record<string, unknown>>)[0].content).toEqual([
        {
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${Buffer.from('jpg bytes').toString('base64')}`,
          detail: 'auto',
        },
      ]);

      const jpegResult = sanitizePayload(
        {
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: jpegPath }],
            },
          ],
        },
        'grok-4.3',
        undefined,
        dir,
      );
      expect((jpegResult.input as Array<Record<string, unknown>>)[0].content).toEqual([
        {
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${Buffer.from('jpeg bytes').toString('base64')}`,
          detail: 'auto',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported local image extensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-test-'));
    const gifPath = join(dir, 'animation.gif');
    writeFileSync(gifPath, Buffer.from('gif bytes'));

    try {
      expect(() =>
        sanitizePayload(
          {
            input: [
              {
                role: 'user',
                content: [{ type: 'input_image', image_url: gifPath }],
              },
            ],
          },
          'grok-4.3',
          undefined,
          dir,
        ),
      ).toThrow(/xAI image understanding supports local .jpg, .jpeg, and .png files only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves file:// protocol image paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-test-'));
    const imagePath = join(dir, 'file-ref.png');
    writeFileSync(imagePath, Buffer.from('file ref png'));

    try {
      const payload = sanitizePayload(
        {
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: `file://${imagePath}` }],
            },
          ],
        },
        'grok-4.3',
        undefined,
        dir,
      );

      expect((payload.input as Array<Record<string, unknown>>)[0].content).toEqual([
        {
          type: 'input_image',
          image_url: `data:image/png;base64,${Buffer.from('file ref png').toString('base64')}`,
          detail: 'auto',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid file:// URLs gracefully', () => {
    expect(() =>
      sanitizePayload(
        {
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: 'file://invalid-url' }],
            },
          ],
        },
        'grok-4.3',
        undefined,
        process.cwd(),
      ),
    ).toThrow('Image file does not exist or is not a valid URL: file://invalid-url');
  });

  it('rewrites function_call_output with plain string parts', () => {
    const payload = sanitizePayload(
      {
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_s',
            output: ['plain string output', { type: 'input_text', text: 'object output' }],
          },
        ],
      },
      'grok-4.3',
      undefined,
      process.cwd(),
    );

    expect(payload.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'call_s',
        output: 'plain string output\nobject output',
      },
    ]);
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
        undefined,
        process.cwd(),
      ),
    ).toThrow('Image file does not exist or is not a valid URL: missing.png');
  });

  it('rejects local image paths outside the workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-grok-cli-test-'));
    const workspace = join(dir, 'workspace');
    const originalCwd = process.cwd();
    writeFileSync(join(dir, 'secret.png'), Buffer.from('png image bytes'));
    mkdirSync(workspace);

    try {
      process.chdir(workspace);

      expect(() =>
        sanitizePayload(
          {
            input: [
              {
                role: 'user',
                content: [{ type: 'input_image', image_url: join('..', 'secret.png') }],
              },
            ],
          },
          'grok-4.3',
          undefined,
          process.cwd(),
        ),
      ).toThrow('Image path is outside the workspace');
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

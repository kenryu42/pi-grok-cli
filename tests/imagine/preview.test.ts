import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetCapabilitiesCache, setCapabilities } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';
import { imagePreview } from '../../src/imagine/preview.js';
import { tempDir } from '../tools/toolTestHelpers.js';

const JPEG = '/9j/2Q==';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const theme = { fg: (_color: string, text: string) => text };

afterEach(() => resetCapabilitiesCache());

function fixtureImages() {
  const dir = tempDir('imagine-render-');
  const path = join(dir, '1.jpg');
  const previewPath = join(dir, '1.png');
  writeFileSync(path, Buffer.from(JPEG, 'base64'));
  writeFileSync(previewPath, Buffer.from(PNG, 'base64'));
  return { path, previewPath };
}

describe('imagePreview', () => {
  it('sends the PNG sidecar through Kitty f=100 rendering', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const paths = fixtureImages();
    const rendered = imagePreview({ ...paths, label: 'saved images/1.jpg', theme }).render(120);
    const sequence = rendered.find((line) => line.includes('\u001b_G')) ?? '';
    expect(sequence).toContain('f=100');
    expect(sequence).toContain(PNG.slice(0, 24));
    expect(sequence).not.toContain(JPEG);
  });

  it('prefers PNG on iTerm2 but falls back to JPEG when no sidecar exists', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: true });
    const paths = fixtureImages();
    expect(
      imagePreview({ ...paths, label: 'saved', theme })
        .render(120)
        .join('\n'),
    ).toContain(PNG.slice(0, 24));
    expect(
      imagePreview({ path: paths.path, label: 'saved', theme }).render(120).join('\n'),
    ).toContain(JPEG);
  });

  it('shows a textual fallback instead of blank Kitty rows without a PNG preview', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const paths = fixtureImages();
    const rendered = imagePreview({
      path: paths.path,
      previewError: 'PNG conversion failed',
      label: 'saved images/1.jpg',
      theme,
    })
      .render(120)
      .map((line) => line.trimEnd());
    expect(rendered).toEqual(['saved images/1.jpg', 'preview unavailable: PNG conversion failed']);
    expect(rendered.some((line) => line.includes('\u001b_G'))).toBe(false);
  });
});

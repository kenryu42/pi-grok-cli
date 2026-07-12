import { readFileSync } from 'node:fs';
import { Container, getCapabilities, Image, Text } from '@earendil-works/pi-tui';

type PreviewTheme = {
  fg: (color: 'success' | 'muted', text: string) => string;
};

function unavailable(header: Text, message: string, theme: PreviewTheme) {
  const container = new Container();
  container.addChild(header);
  container.addChild(new Text(theme.fg('muted', `preview unavailable: ${message}`), 0, 0));
  return container;
}

export function imagePreview(options: {
  path: string;
  previewPath?: string;
  previewError?: string;
  label: string;
  theme: PreviewTheme;
  showImage?: boolean;
}) {
  const header = new Text(options.theme.fg('success', options.label), 0, 0);
  if (options.showImage === false) return header;
  if (getCapabilities().images === 'kitty' && !options.previewPath) {
    return unavailable(header, options.previewError ?? 'PNG preview missing', options.theme);
  }
  const imagePath = options.previewPath ?? options.path;
  const mimeType = options.previewPath ? 'image/png' : 'image/jpeg';
  try {
    const container = new Container();
    container.addChild(header);
    container.addChild(
      new Image(
        readFileSync(imagePath).toString('base64'),
        mimeType,
        { fallbackColor: (text) => options.theme.fg('muted', text) },
        { maxWidthCells: 60, maxHeightCells: 24, filename: options.path },
      ),
    );
    return container;
  } catch {
    return unavailable(
      header,
      options.previewError ?? 'preview file could not be read',
      options.theme,
    );
  }
}

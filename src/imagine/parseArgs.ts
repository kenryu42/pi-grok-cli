import { normalizeAspectRatio } from './aspect.js';

function tokenize(args: string) {
  const tokens = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.map((token) =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token,
  );
}

export function parseImagineArgs(args: string) {
  const tokens = tokenize(args);
  const optionValues = new Map<string, string>();
  const prompt: string[] = [];
  const aliases = new Map([
    ['--aspect', 'aspect'],
    ['--aspect-ratio', 'aspect'],
    ['--out', 'out'],
    ['-o', 'out'],
    ['--resolution', 'resolution'],
  ]);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('-')) {
      prompt.push(token);
      continue;
    }
    const option = aliases.get(token);
    if (!option) throw new Error(`Unknown option: ${token}`);
    const value = tokens[index + 1];
    if (!value || value.startsWith('-')) throw new Error(`${token} requires a value`);
    optionValues.set(option, value);
    index += 1;
  }

  if (prompt.length === 0) throw new Error('Prompt is required');
  const resolution = optionValues.get('resolution') ?? '1k';
  if (resolution !== '1k') throw new Error('Unsupported resolution. Only 1k is available.');
  return {
    prompt: prompt.join(' '),
    aspectRatio: normalizeAspectRatio(optionValues.get('aspect')),
    ...(optionValues.has('out') ? { outPath: optionValues.get('out') } : {}),
    resolution,
  };
}

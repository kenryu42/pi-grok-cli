export const IMAGINE_ASPECT_RATIOS = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '2:1',
  '1:2',
  '19.5:9',
  '9:19.5',
  '20:9',
  '9:20',
] as const;

export function normalizeAspectRatio(value = 'auto') {
  const normalized = value.trim();
  if (IMAGINE_ASPECT_RATIOS.includes(normalized as (typeof IMAGINE_ASPECT_RATIOS)[number])) {
    return normalized;
  }
  throw new Error(
    `Unsupported aspect ratio "${value}". Use one of: ${IMAGINE_ASPECT_RATIOS.join(', ')}`,
  );
}

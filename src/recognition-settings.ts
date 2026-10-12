import {
  DEFAULT_RECOGNITION,
  type QuestionType,
  type RecognitionSettings,
} from './domain';

export interface RecognitionMarkerContext {
  questionType: QuestionType;
  part: 'stem' | 'option';
  blankCount?: number;
}

export const MIN_VISION_CONCURRENCY = 1;
export const MAX_VISION_CONCURRENCY = 128;
export const RECOGNITION_STRATEGIES = [
  'ocr-only',
  'vision-only',
  'ocr-first',
  'vision-first',
] as const;
export function recognitionDefaults(
  value?: Partial<RecognitionSettings>,
): RecognitionSettings {
  return {
    strategy: RECOGNITION_STRATEGIES.includes(
      value?.strategy as RecognitionSettings['strategy'],
    )
      ? value!.strategy!
      : DEFAULT_RECOGNITION.strategy,
    imageStrategy:
      value?.imageStrategy === 'manual' ||
      RECOGNITION_STRATEGIES.includes(
        value?.imageStrategy as RecognitionSettings['strategy'],
      )
        ? value!.imageStrategy
        : DEFAULT_RECOGNITION.imageStrategy,
    validateOcr:
      typeof value?.validateOcr === 'boolean'
        ? value.validateOcr
        : DEFAULT_RECOGNITION.validateOcr,
    visionService:
      value?.visionService === 'independent' ? 'independent' : 'shared',
    visionConcurrency: Number.isInteger(value?.visionConcurrency)
      ? Math.min(
          MAX_VISION_CONCURRENCY,
          Math.max(MIN_VISION_CONCURRENCY, value!.visionConcurrency!),
        )
      : DEFAULT_RECOGNITION.visionConcurrency,
  };
}
export function recognitionEngines(
  settings: RecognitionSettings,
): ('ocr' | 'vision')[] {
  switch (settings.strategy) {
    case 'ocr-only':
      return ['ocr'];
    case 'vision-only':
      return ['vision'];
    case 'vision-first':
      return ['vision', 'ocr'];
    default:
      return ['ocr', 'vision'];
  }
}
// Preserve code whitespace, operators, numbers and blank positions. Ignore
// underline run width because the page and OCR render the same blank differently.
function isBlankStem(
  context?: RecognitionMarkerContext,
): context is RecognitionMarkerContext {
  return context?.questionType === 'blank' && context.part === 'stem';
}

interface BlankMarker {
  index: number;
  length: number;
  ordinal?: string;
}

function blankMarkers(value: string): BlankMarker[] {
  const markers: BlankMarker[] = [];
  const pattern = /(?<![A-Za-z0-9_])_+(?=\d+\s*[.、．]|[^A-Za-z0-9_]|$)/g;
  for (const match of value.matchAll(pattern)) {
    const index = match.index!;
    const prefix = value.slice(Math.max(0, index - 120), index);
    const ordinal = prefix.match(/(?:^|[^\d])(\d+)\s*[.、．]\s*$/)?.[1];
    markers.push({ index, length: match[0].length, ordinal });
  }
  return markers;
}

function normalizeBlankLayout(value: string): string {
  let normalized = value;
  for (const marker of blankMarkers(value).reverse()) {
    let start = marker.index;
    let end = marker.index + marker.length;
    while (start > 0 && /\s/.test(normalized[start - 1]!)) start--;
    while (end < normalized.length && /\s/.test(normalized[end]!)) end++;
    normalized = `${normalized.slice(0, start)}_${normalized.slice(end)}`;
  }
  return normalized;
}

export function comparableText(
  value: string,
  context?: RecognitionMarkerContext,
): string {
  const blankStem = isBlankStem(context);
  const layoutNormalized = blankStem ? normalizeBlankLayout(value) : value;
  const normalized = blankStem
    ? layoutNormalized
        .replace(/([\u3400-\u9fff])\s+(?=\d+\s*[.、．])/g, '$1')
        .replace(/(\d+\s*[.、．])\s+/g, '$1')
    : layoutNormalized;
  return normalized
    .trim()
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/(?<![A-Za-z0-9])_+(?![A-Za-z0-9_])/g, '_')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/，/g, ',')
    .replace(/。/g, '.');
}
export function literalMarkers(value: string): string {
  return (value.match(/(?<![A-Za-z0-9])_+(?![A-Za-z0-9_])|[()（）]/g) ?? [])
    .map((marker) =>
      marker.startsWith('_')
        ? '_'
        : marker.replace(/（/g, '(').replace(/）/g, ')'),
    )
    .join('|');
}

export function validateRecognitionMarkers(
  source: string,
  recognized: string,
  context?: RecognitionMarkerContext,
): { valid: boolean; reason?: string } {
  const sourceBrackets = (source.match(/[()（）]/g) ?? [])
    .map((mark) => mark.replace(/（/g, '(').replace(/）/g, ')'))
    .join('');
  const recognizedBrackets = (recognized.match(/[()（）]/g) ?? [])
    .map((mark) => mark.replace(/（/g, '(').replace(/）/g, ')'))
    .join('');
  if (sourceBrackets !== recognizedBrackets)
    return {
      valid: false,
      reason: isBlankStem(context)
        ? '括号与网页不一致'
        : '括号或填空标记与网页不一致',
    };

  if (isBlankStem(context)) {
    const expected = context.blankCount;
    const sourceBlanks = blankMarkers(source);
    const recognizedBlanks = blankMarkers(recognized);
    if (expected === undefined || !Number.isInteger(expected) || expected < 0)
      return { valid: false, reason: '实际填空位置数量无法确认' };
    if (sourceBlanks.length !== expected)
      return {
        valid: false,
        reason: `网页填空标记与输入位置数量不一致（网页 ${sourceBlanks.length} 个，输入位置 ${expected} 个）`,
      };
    if (recognizedBlanks.length !== expected)
      return {
        valid: false,
        reason: `填空数量不一致（期望 ${expected} 个，识别到 ${recognizedBlanks.length} 个）`,
      };
    const sourceOrdinals = sourceBlanks.map((marker) => marker.ordinal ?? '');
    const recognizedOrdinals = recognizedBlanks.map(
      (marker) => marker.ordinal ?? '',
    );
    if (
      (sourceOrdinals.some(Boolean) || recognizedOrdinals.some(Boolean)) &&
      sourceOrdinals.join('|') !== recognizedOrdinals.join('|')
    )
      return { valid: false, reason: '填空编号或顺序与网页不一致' };
    return { valid: true };
  }

  if (literalMarkers(source) !== literalMarkers(recognized))
    return { valid: false, reason: '括号或填空标记与网页不一致' };
  return { valid: true };
}

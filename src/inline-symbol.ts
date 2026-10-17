import type { RecognitionAttempt } from './domain';

/** Only a small, connected glyph can use the plain-character OCR exception. */
export function isInlineGlyph(
  canvas: HTMLCanvasElement,
  source: { width: number; height: number },
): boolean {
  if (source.width > 64 || source.height > 64) return false;
  try {
    const { width, height } = canvas;
    if (!width || !height || width * height > 100000) return false;
    const pixels = canvas
      .getContext('2d')
      ?.getImageData(0, 0, width, height).data;
    if (!pixels) return false;
    const ink = new Uint8Array(width * height);
    let count = 0;
    let first = -1;
    let left = width,
      right = 0,
      top = height,
      bottom = 0;
    for (let i = 0; i < ink.length; i++) {
      const offset = i * 4;
      if (
        pixels[offset + 3]! < 128 ||
        pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]! > 480
      )
        continue;
      ink[i] = 1;
      count++;
      first = i;
      const x = i % width,
        y = Math.floor(i / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    const ratio = (right - left + 1) / (bottom - top + 1);
    if (count < 8 || ratio < 0.2 || ratio > 1.6) return false;
    const queue = new Int32Array(count);
    queue[0] = first;
    ink[first] = 0;
    let visited = 1;
    for (let head = 0; head < visited; head++) {
      const index = queue[head]!;
      const x = index % width,
        y = Math.floor(index / width);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const next = ny * width + nx;
          if (ink[next]) {
            ink[next] = 0;
            queue[visited++] = next;
          }
        }
    }
    return visited === count;
  } catch {
    return false;
  }
}

function plainSymbol(value: string): string | undefined {
  const text = value
    .trim()
    .replace(/^\\\(([\s\S]*)\\\)$/, '$1')
    .trim();
  return /^[a-z0-9]$/i.test(text) ? text : undefined;
}

/** Do not infer a formula from OCR that may have dropped a subscript or fraction. */
export function confirmedInlineSymbol(
  attempt: RecognitionAttempt,
  isolatedGlyph: boolean,
  evidence: RecognitionAttempt[],
): string | undefined {
  const symbol = attempt.text?.trim();
  if (
    !isolatedGlyph ||
    !attempt.success ||
    !symbol ||
    !/^[a-z0-9]$/i.test(symbol) ||
    (attempt.readings?.length ?? 0) < 2
  )
    return;
  if (
    !attempt.readings!.every(
      (reading) =>
        reading.text.trim() === symbol &&
        Number.isFinite(reading.confidence) &&
        reading.confidence >= 90,
    )
  )
    return;
  if (
    evidence.some(
      (reading) =>
        reading.engine === 'vision' &&
        (reading.contentKind === 'text' || reading.contentKind === 'formula') &&
        reading.text?.trim() &&
        plainSymbol(reading.text) !== symbol,
    )
  )
    return;
  return symbol;
}

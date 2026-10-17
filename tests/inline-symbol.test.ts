import { describe, expect, it } from 'vitest';
import type { RecognitionAttempt } from '../src/domain';
import { confirmedInlineSymbol, isInlineGlyph } from '../src/inline-symbol';

const letter = [
  '...##...',
  '..#..#..',
  '.#....#.',
  '.######.',
  '.#....#.',
  '.#....#.',
  '.#....#.',
];
function canvas(rows: string[], unavailable = false): HTMLCanvasElement {
  const width = Math.max(...rows.map((row) => row.length));
  const height = rows.length;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  rows.forEach((row, y) =>
    [...row].forEach((pixel, x) => {
      if (pixel === '#')
        data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }),
  );
  return {
    width,
    height,
    getContext: () => ({
      getImageData: () => {
        if (unavailable) throw new Error('pixels unavailable');
        return { data };
      },
    }),
  } as unknown as HTMLCanvasElement;
}
function reading(text = 'A', confidence = 95): RecognitionAttempt {
  return {
    engine: 'ocr',
    success: true,
    text,
    readings: [
      { text, confidence },
      { text, confidence },
    ],
  };
}
describe('简单行内字符的独立确认', () => {
  it('仅允许小幅、连通的单字形，不能用 OCR 字母代替上标、下标或分式', () => {
    const source = { width: 16, height: 18 };
    expect(isInlineGlyph(canvas(letter), source)).toBe(true);
    expect(isInlineGlyph(canvas(letter), { width: 640, height: 480 })).toBe(
      false,
    );
    expect(
      isInlineGlyph(
        canvas([
          '.............##',
          '.............##',
          '...............',
          ...letter.map((row) => row.padEnd(15, '.')),
        ]),
        source,
      ),
    ).toBe(false);
    expect(
      isInlineGlyph(canvas([...letter, '........', '..####..']), source),
    ).toBe(false);
    expect(isInlineGlyph(canvas(['........']), source)).toBe(false);
    expect(isInlineGlyph(canvas(letter, true), source)).toBe(false);
  });
  it('两次高置信度结果相同才确认单个字母或数字', () => {
    for (const symbol of ['A', 'x', '7'])
      expect(confirmedInlineSymbol(reading(symbol), true, [])).toBe(symbol);
    expect(confirmedInlineSymbol(reading(), false, [])).toBeUndefined();
    expect(
      confirmedInlineSymbol({ ...reading(), success: false }, true, []),
    ).toBeUndefined();
    expect(
      confirmedInlineSymbol(
        { ...reading(), readings: [{ text: 'A', confidence: 99 }] },
        true,
        [],
      ),
    ).toBeUndefined();
    expect(confirmedInlineSymbol(reading('A', 89), true, [])).toBeUndefined();
    expect(confirmedInlineSymbol(reading('A', NaN), true, [])).toBeUndefined();
    expect(
      confirmedInlineSymbol(
        {
          ...reading(),
          readings: [
            { text: 'A', confidence: 99 },
            { text: '4', confidence: 99 },
          ],
        },
        true,
        [],
      ),
    ).toBeUndefined();
    for (const text of ['x^2', '1/2', 'AB'])
      expect(confirmedInlineSymbol(reading(text), true, [])).toBeUndefined();
  });
  it('独立证据可以确认相同的未确定字母，但不能覆盖视觉读法冲突', () => {
    const vision: RecognitionAttempt = {
      engine: 'vision',
      success: false,
      contentKind: 'formula',
      text: String.raw`\(A\)`,
    };
    expect(confirmedInlineSymbol(reading(), true, [vision])).toBe('A');
    expect(vision.success).toBe(false);
    expect(
      confirmedInlineSymbol(reading(), true, [
        { ...vision, text: String.raw`\(4\)` },
      ]),
    ).toBeUndefined();
    expect(
      confirmedInlineSymbol(reading(), true, [
        { ...vision, contentKind: 'text', text: '4' },
      ]),
    ).toBeUndefined();
    expect(
      confirmedInlineSymbol(reading('x'), true, [
        { ...vision, text: String.raw`\(x^2\)` },
      ]),
    ).toBeUndefined();
  });
});

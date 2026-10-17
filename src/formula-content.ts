import type { QuestionImage, QuestionRecord } from './domain';

/** Chaoxing formula widgets store URI-encoded JSON strings, not rendered glyphs. */
export function pageFormula(node: Element): string | undefined {
  if (!node.matches('img.ans-latex-moudle,img.ans-latex-module')) return;
  const raw = node.getAttribute('data')?.trim();
  if (!raw || raw.length > 48000) return;
  try {
    const value: unknown = JSON.parse(
      raw.startsWith('"') ? raw : decodeURIComponent(raw),
    );
    if (typeof value !== 'string') return;
    let latex = value.trim();
    if (
      (latex.startsWith('\\(') && latex.endsWith('\\)')) ||
      (latex.startsWith('\\[') && latex.endsWith('\\]'))
    )
      latex = latex.slice(2, -2).trim();
    if (
      !latex ||
      latex.length > 12000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|〔图片\d+〕/.test(latex)
    )
      return;
    return latex;
  } catch {
    return;
  }
}

export function formulaText(latex: string): string {
  return `\\(${latex}\\)`;
}

/** Context locates the image and supplies page-authored formulas without guessing. */
export function formulaImageContext(
  question: QuestionRecord,
  image: QuestionImage,
): string {
  const originalText = (text: string) =>
    (question.images ?? []).reduce(
      (value, source) =>
        source.latex
          ? value.replace(source.placeholder, formulaText(source.latex))
          : value,
      text,
    );
  const option = question.options.find((item) => item.id === image.optionId);
  return JSON.stringify({
    questionNumber: question.number,
    stem: originalText(question.stem).slice(0, 4000),
    part: image.part,
    ...(option ? { optionLabel: option.label } : {}),
    surroundingText: originalText(option?.text ?? question.stem).slice(0, 4000),
    placeholder: image.placeholder,
  });
}

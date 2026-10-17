import type { PageSnapshot, QuestionImage, QuestionRecord } from './domain';
import { hashText, safeQuestionImageUrl } from './security';
import { pageFormula } from './formula-content';

/** Replace images in a cloned text region, preserving their DOM order. */
export function extractImageContent(
  region: Element | undefined,
  images: QuestionImage[],
  questionId: string,
  base: string,
  part: 'stem' | 'option',
  optionId?: string,
): void {
  for (const node of region?.querySelectorAll('img') ?? []) {
    const index = images.length + 1;
    // Offscreen questions may still display a loading placeholder. Read their
    // original address without scrolling or activating the page's lazy loader.
    const sources = [
      'data-original',
      'data-src',
      'data-lazy-src',
      '_src',
      'src',
      'data-cx-src',
    ]
      .map((attribute) => node.getAttribute(attribute)?.trim())
      .filter((raw): raw is string => Boolean(raw));
    const latex = pageFormula(node);
    const src = sources
      .map(
        (raw) =>
          safeQuestionImageUrl(raw, base) ??
          (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(raw) &&
          raw.length < 8000000
            ? raw
            : undefined),
      )
      .find((value) => value !== undefined);
    // The same resource must retain its identity before and after lazy loading.
    const raw = src ?? sources[0] ?? '';
    const placeholder = `〔图片${index}〕`;
    images.push({
      id: `q${questionId}:image${index}`,
      part,
      ...(optionId ? { optionId } : {}),
      placeholder,
      src,
      resourceKey: hashText(latex ? JSON.stringify([raw, latex]) : raw),
      ...(latex ? { latex } : {}),
      width: Number(node.getAttribute('width')) || undefined,
      height: Number(node.getAttribute('height')) || undefined,
    });
    node.replaceWith(node.ownerDocument.createTextNode(placeholder));
  }
}

export function imagesForPart(
  question: QuestionRecord,
  optionId?: string,
): QuestionImage[] {
  return (question.images ?? []).filter((image) =>
    optionId === undefined
      ? image.part === 'stem'
      : image.part === 'option' && image.optionId === optionId,
  );
}

/** Images still referenced by the prepared text must accompany the solve request. */
export function answerImages(question: QuestionRecord): QuestionImage[] {
  return (question.images ?? []).filter((image) => {
    const text =
      image.part === 'stem'
        ? question.stem
        : question.options.find((option) => option.id === image.optionId)?.text;
    return text?.includes(image.placeholder);
  });
}

export function requiresTextRecognition(
  question: QuestionRecord,
  optionId?: string,
): boolean {
  return (
    imagesForPart(question, optionId).length > 0 ||
    (optionId === undefined
      ? Boolean(question.obfuscated)
      : Boolean(
          question.options.find((option) => option.id === optionId)?.obfuscated,
        ))
  );
}

export function placeholdersPreserved(source: string, text: string): boolean {
  return (
    (source.match(/〔图片\d+〕/g) ?? []).join('|') ===
    (text.match(/〔图片\d+〕/g) ?? []).join('|')
  );
}

/** Resource addresses are needed only for the active extraction/recognition job. */
export function stripImageResources(page?: PageSnapshot): void {
  for (const question of page?.questions ?? [])
    for (const image of question.images ?? []) delete image.src;
}

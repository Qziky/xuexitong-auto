import type { PageSnapshot, QuestionImage, QuestionRecord } from './domain';
import { hashText, safePageUrl } from './security';
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
    const raw = node.getAttribute('src') ?? '';
    const latex = pageFormula(node);
    const src =
      safePageUrl(raw, base) ??
      (/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(raw) &&
      raw.length < 8000000
        ? raw
        : undefined);
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

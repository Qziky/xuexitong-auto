import type { AnswerProposal, QuestionRecord } from './domain';
type AnswerQuestion = Pick<
  QuestionRecord,
  'id' | 'type' | 'options' | 'blanks'
>;
function ordinal(text: string): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const digits = '零一二三四五六七八九';
  if (text === '十') return 10;
  if (text.length === 1) {
    const n = digits.indexOf(text);
    return n > 0 ? n : undefined;
  }
  const parts = text.split('十');
  if (parts.length === 2) {
    const tens = parts[0] ? digits.indexOf(parts[0]) : 1,
      ones = parts[1] ? digits.indexOf(parts[1]) : 0;
    return tens > 0 && ones >= 0 ? tens * 10 + ones : undefined;
  }
}
export function displayedBlanks(
  el: Element,
  source: 'own' | 'platform',
): string[] | undefined {
  const parent =
    source === 'own'
      ? (el.querySelector('.myAllAnswerBx') ?? el.querySelector('.myAnswerBx'))
      : el.querySelector(
          '.correctAnswerBx,.rightAnswer,.answer_right,[data-standard-answer]',
        );
  if (!parent) return undefined;
  const values = [
    ...parent.querySelectorAll(
      source === 'own' ? '.myAnswer' : '.correctAnswer',
    ),
  ]
    .map((node) => {
      const text = (node.textContent ?? '').trim(),
        match = text.match(/^第([\d一二三四五六七八九十]+)空\s*[:：]\s*/);
      return match
        ? {
            index: ordinal(match[1]!),
            value: text.slice(match[0].length).trim(),
          }
        : undefined;
    })
    .filter(
      (v): v is { index: number; value: string } =>
        !!v && v.index !== undefined,
    );
  if (!values.length) return undefined;
  return values.every((value, i) => value.index === i + 1)
    ? values.map((v) => v.value)
    : undefined;
}
function parseAnswer(
  el: Element,
  question: AnswerQuestion,
  source: 'own' | 'platform',
): AnswerProposal | undefined {
  const selectors =
    source === 'own'
      ? '.myAnswerBx,.myAnswer,[data-own-answer]'
      : '.correctAnswerBx,[data-standard-answer],.rightAnswer,.correctAnswer,.mark_answer,.answer_right';
  const label = source === 'own' ? /我的答案|本人答案/ : /正确答案|标准答案/;
  const modern = el.querySelector(
    source === 'own' ? '.stuAnswerContent' : '.rightAnswerContent',
  );
  const explicit =
    modern && label.test(modern.parentElement?.textContent ?? '')
      ? modern
      : undefined;
  const region =
    explicit ??
    [...el.querySelectorAll(selectors)].find((node) =>
      label.test(node.textContent ?? ''),
    );
  if (!region) return undefined;
  const content =
    question.type === 'blank'
      ? region
      : (explicit ?? region.querySelector('.answerCon') ?? region);
  const value = (content.textContent ?? '')
    .replace(
      source === 'own'
        ? /^.*?(?:我的答案|本人答案)\s*[:：]?\s*/
        : /^.*?(?:正确答案|标准答案)\s*[:：]?\s*/,
      '',
    )
    .trim();
  const base = {
    questionId: question.id,
    needsReview: false,
    explanation: source === 'own' ? '页面显示的本人答案' : '平台明确公布的答案',
    source,
  };
  if (question.type === 'blank') {
    const grouped = displayedBlanks(el, source);
    const blanks =
      grouped ??
      value
        .split(/第[\d一二三四五六七八九十]+空\s*[:：]/)
        .map((v) => v.trim())
        .filter(Boolean);
    return blanks.length === question.blanks.length
      ? { ...base, blanks }
      : undefined;
  }
  if (
    question.type === 'boolean' &&
    /^(?:对|错|正确|错误|true|false)$/i.test(value)
  ) {
    const positive = /^(?:对|正确|true)$/i.test(value);
    const option = question.options.find((o) =>
      positive
        ? /^(?:对|正确|true)$/i.test(o.text.trim())
        : /^(?:错|错误|false)$/i.test(o.text.trim()),
    );
    return option ? { ...base, optionIds: [option.id] } : undefined;
  }
  const labels = value.match(/[A-Z]/g);
  if (!labels || labels.length !== value.replace(/[\s,，、；;]/g, '').length)
    return undefined;
  const options = labels.map((label) =>
    question.options.find(
      (o) => o.label.replace(/[.、．]/g, '').trim() === label,
    ),
  );
  return options.every(Boolean)
    ? { ...base, optionIds: options.map((o) => o!.id) }
    : undefined;
}
export function readPublishedAnswer(el: Element, question: AnswerQuestion) {
  return parseAnswer(el, question, 'platform');
}
export function readOwnAnswer(el: Element, question: AnswerQuestion) {
  return parseAnswer(el, question, 'own');
}

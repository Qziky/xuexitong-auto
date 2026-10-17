import type { AnswerProposal, PageSnapshot, QuestionRecord } from './domain';
import { existingProposal, normalizeText } from './answers';
import { answerImages } from './image-content';

export const QUESTION_TYPE_LABEL = {
  single: '单选题',
  multiple: '多选题',
  boolean: '判断题',
  blank: '填空题',
  unsupported: '其他题型',
};
export function answerText(q: QuestionRecord, answer?: AnswerProposal): string {
  if (!answer) return '尚无答案';
  if (q.type === 'blank')
    return (
      answer.blanks
        ?.map((value, i) => '第' + (i + 1) + '空：' + (value || '未填写'))
        .join('；') || '未填写'
    );
  return (
    answer.optionIds
      ?.map((id) => {
        const option = q.options.find((o) => o.id === id);
        return option ? option.label + '. ' + option.text : '无法对应的选项';
      })
      .join('；') || '未选择'
  );
}
export function comparison(
  q: QuestionRecord,
  reference?: AnswerProposal,
): 'same' | 'different' | 'empty' {
  const mine = existingProposal(q);
  if (
    q.type === 'blank'
      ? !mine.blanks?.some((v) => v.trim())
      : !mine.optionIds?.length
  )
    return 'empty';
  if (!reference) return 'empty';
  return q.type === 'blank'
    ? JSON.stringify(mine.blanks?.map(normalizeText)) ===
      JSON.stringify(reference.blanks?.map(normalizeText))
      ? 'same'
      : 'different'
    : [...(mine.optionIds ?? [])].sort().join('|') ===
        [...(reference.optionIds ?? [])].sort().join('|')
      ? 'same'
      : 'different';
}
export interface QuestionExportOptions {
  own?: boolean;
  reference?: boolean;
  explanation?: boolean;
}
export function exportQuestions(
  page: PageSnapshot,
  proposals: AnswerProposal[],
  options: QuestionExportOptions = {},
): { filename: string; text: string } {
  const lines = [page.title, '题目共 ' + page.questions.length + ' 道', ''];
  for (const q of page.questions) {
    lines.push(q.number + '. [' + QUESTION_TYPE_LABEL[q.type] + '] ' + q.stem);
    if (q.issues.length) lines.push('【内容待确认】' + q.issues.join('；'));
    for (const option of q.options)
      lines.push(option.label + '. ' + option.text);
    for (const image of answerImages(q))
      lines.push(
        image.placeholder +
          '：原图材料（TXT 不包含图片，可在题目详情下载原图）',
      );
    const reference = proposals.find(
      (p) => p.questionId === q.id && p.source !== 'own',
    );
    if (options.own)
      lines.push('我的答案（网页）：' + answerText(q, existingProposal(q)));
    if (options.reference) {
      lines.push('模型参考（待核对）：' + answerText(q, reference));
      if (q.publishedAnswer)
        lines.push('平台公布答案：' + answerText(q, q.publishedAnswer));
    }
    if (options.explanation && reference)
      lines.push('模型解析：' + reference.explanation);
    lines.push('');
  }
  return {
    filename:
      (page.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 100) ||
        '题目') + '.txt',
    text: '\uFEFF' + lines.join('\n').replace(/\r?\n/g, '\r\n'),
  };
}

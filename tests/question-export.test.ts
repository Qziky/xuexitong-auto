import { expect, it } from 'vitest';
import { comparison, exportQuestions } from '../src/question-export';
import { invalidateCandidates } from '../src/cache-invalidation';
import { initialState, type PageSnapshot } from '../src/domain';
const page = {
  title: '练习:极限',
  questions: [
    {
      id: '1',
      number: 1,
      type: 'single',
      stem: '求 lim x',
      options: [
        { id: 'o1', label: 'A', text: '0', key: 'D' },
        { id: 'o2', label: 'B', text: '1', key: 'A' },
      ],
      blanks: [],
      existing: ['o1'],
      issues: [],
      required: true,
      recognition: { stem: { source: 'ocr', attempts: [] }, options: {} },
    },
  ],
} as unknown as PageSnapshot;
const answer = {
  questionId: '1',
  optionIds: ['o2'],
  needsReview: false,
  explanation: '解析',
  source: 'model' as const,
};
it('TXT defaults to content, uses BOM/CRLF and optional answers have separate sources', () => {
  const value = exportQuestions(page, [answer]);
  expect(value.text.charCodeAt(0)).toBe(0xfeff);
  expect(value.text).toContain('\r\n');
  expect(value.text).not.toContain('我的答案');
  expect(value.filename).toBe('练习_极限.txt');
  expect(
    exportQuestions(page, [answer], {
      own: true,
      reference: true,
      explanation: true,
    }).text,
  ).toContain('模型参考（待核对）：B. 1');
  expect(comparison(page.questions[0]!, answer)).toBe('different');
});
it('answer configuration invalidates candidates without discarding dependable OCR or manual text', () => {
  const s = initialState();
  s.preparations.one = {
    taskId: 'one',
    snapshot: structuredClone(page),
    decoded: true,
    proposals: [answer],
  } as any;
  invalidateCandidates(s, () => false);
  expect(s.preparations.one!.decoded).toBe(true);
  expect(s.preparations.one!.snapshot).toEqual(page);
  expect(s.preparations.one!.proposals).toBeUndefined();
});

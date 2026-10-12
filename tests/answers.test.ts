import { describe, expect, it } from 'vitest';
import {
  completeAnswer,
  needsSolve,
  normalizeProposal,
  parseAnswerJson,
  readbackMatches,
  validateBatch,
} from '../src/answers';
import type { QuestionRecord } from '../src/domain';
const single: QuestionRecord = {
  id: '1',
  number: 1,
  type: 'single',
  stem: '示例',
  required: true,
  issues: [],
  options: [
    { id: 'q1:o1', key: 'D', label: 'A', text: '选项一' },
    { id: 'q1:o2', key: 'A', label: 'B', text: '选项二' },
  ],
  blanks: [],
  existing: ['q1:o1'],
};
const blank: QuestionRecord = {
  id: '2',
  number: 2,
  type: 'blank',
  stem: '填空',
  required: true,
  issues: [],
  options: [],
  blanks: [
    { id: 'b0', kind: 'textarea', value: '原答案' },
    { id: 'b1', kind: 'input', value: '' },
  ],
  existing: ['原答案', ''],
};
describe('草稿与模型答案校验', () => {
  it('默认保留已有选择，覆盖模式重新求解', () => {
    expect(needsSolve(single, 'preserve')).toBe(false);
    expect(needsSolve(single, 'overwrite')).toBe(true);
  });
  it('多空题只补空，并按真实输入顺序保留已有答案', () => {
    const raw = {
      questionId: '2',
      blanks: ['模型覆盖值', '第二空'],
      explanation: '示例',
      needsReview: false,
    };
    expect(needsSolve(blank, 'preserve')).toBe(true);
    expect(normalizeProposal(blank, raw, 'preserve').blanks).toEqual([
      '原答案',
      '第二空',
    ]);
    expect(normalizeProposal(blank, raw, 'overwrite').blanks).toEqual([
      '模型覆盖值',
      '第二空',
    ]);
  });
  it('不能把选项显示字母或真实键当扩展选项 ID', () => {
    expect(() =>
      normalizeProposal(
        single,
        {
          questionId: '1',
          optionIds: ['D'],
          explanation: '',
          needsReview: false,
        },
        'overwrite',
      ),
    ).toThrow('不存在');
  });
  it('填空数量、单选数量、重复题目 ID、缺少检查标记均被拒绝', () => {
    expect(() =>
      normalizeProposal(
        blank,
        {
          questionId: '2',
          blanks: ['一个'],
          explanation: '',
          needsReview: false,
        },
        'overwrite',
      ),
    ).toThrow('数量');
    expect(() =>
      normalizeProposal(
        single,
        {
          questionId: '1',
          optionIds: ['q1:o1', 'q1:o2'],
          explanation: '',
          needsReview: false,
        },
        'overwrite',
      ),
    ).toThrow('一个');
    expect(() =>
      validateBatch(
        [single, blank],
        { answers: [{ questionId: '1' }, { questionId: '1' }] },
        'overwrite',
      ),
    ).toThrow('重复');
    expect(() =>
      normalizeProposal(
        single,
        { questionId: '1', optionIds: ['q1:o1'], explanation: '' },
        'overwrite',
      ),
    ).toThrow('检查标记');
  });
  it('明确不确定的候选可存草稿但不能提交；没有候选也可进入检查', () => {
    const a = normalizeProposal(
      single,
      {
        questionId: '1',
        optionIds: ['q1:o1'],
        explanation: '不确定',
        needsReview: true,
      },
      'overwrite',
    );
    expect(completeAnswer(single, a)).toBe(false);
    expect(completeAnswer(single, a, true)).toBe(true);
    expect(
      completeAnswer({ ...single, issues: ['题目文字未确认'] }, a, true),
    ).toBe(false);
    expect(completeAnswer(single, { ...a, optionIds: [] }, true)).toBe(false);
    expect(
      normalizeProposal(
        single,
        {
          questionId: '1',
          optionIds: [],
          explanation: '不确定',
          needsReview: true,
        },
        'overwrite',
      ).optionIds,
    ).toEqual([]);
  });
  it('回读按选择集合和按空位顺序比较', () => {
    expect(
      readbackMatches(
        [blank],
        [
          {
            questionId: '2',
            blanks: ['原答案', ''],
            explanation: '',
            needsReview: true,
          },
        ],
      ),
    ).toBe(true);
    expect(
      readbackMatches(
        [blank],
        [
          {
            questionId: '2',
            blanks: ['', '原答案'],
            explanation: '',
            needsReview: false,
          },
        ],
      ),
    ).toBe(false);
  });
  it('只解析 JSON，支持代码围栏或简短前缀', () => {
    expect(parseAnswerJson('```json\n{"answers":[]}\n```')).toEqual({
      answers: [],
    });
    expect(parseAnswerJson('结果如下：{"answers":[]}')).toEqual({
      answers: [],
    });
    expect(() => parseAnswerJson('alert(1)')).toThrow();
  });
});

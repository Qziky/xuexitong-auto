import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../src/domain';
import { serverDraftMatches } from '../src/draft-verification';
const page: PageSnapshot = {
  taskKey: '1:2:work:3',
  fingerprint: 'f',
  adapter: 'modern',
  accountId: 'cx:1',
  url: '',
  title: '',
  status: 'pending',
  questions: [
    {
      id: 'q1',
      number: 1,
      type: 'multiple',
      required: true,
      stem: '题干',
      issues: [],
      blanks: [],
      options: [
        { id: 'o1', key: 'B', label: 'A', text: '一' },
        { id: 'o2', key: 'A', label: 'B', text: '二' },
      ],
      existing: ['o1'],
    },
    {
      id: 'q2',
      number: 2,
      type: 'blank',
      required: true,
      stem: '填空',
      issues: [],
      options: [],
      existing: ['for', 'while'],
      blanks: [
        { id: 'b1', value: 'for', kind: 'input' },
        { id: 'b2', value: 'while', kind: 'ueditor' },
      ],
    },
  ],
};
describe('草稿服务端证据', () => {
  it('答案完全一致且未提交才核验成功，选项按真实键比较', () => {
    const server = structuredClone(page);
    server.fingerprint = 'new-font';
    server.questions[0]!.options.reverse();
    server.questions[0]!.options.forEach((o, i) => {
      const was = o.id;
      o.id = 'new' + i;
      if (was === 'o1') server.questions[0]!.existing = [o.id];
    });
    expect(serverDraftMatches(page, server)).toBe(true);
  });
  it.each([
    'account',
    'task',
    'submitted',
    'blank',
    'option',
    'missing',
    'issues',
  ])('%s 异常不冒充保存成功', (change) => {
    const server = structuredClone(page);
    if (change === 'account') server.accountId = undefined;
    if (change === 'task') server.taskKey = '1:2:work:4';
    if (change === 'submitted') server.status = 'submitted';
    if (change === 'blank') server.questions[1]!.blanks[1]!.value = 'for';
    if (change === 'option') server.questions[0]!.existing = ['o2'];
    if (change === 'missing') server.questions.pop();
    if (change === 'issues') server.questions[0]!.issues = ['未可靠识别'];
    expect(serverDraftMatches(page, server)).toBe(false);
  });
});

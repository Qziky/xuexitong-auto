import { describe, expect, it } from 'vitest';
import { extractPage } from '../src/page-parser';
import { inertDocument } from '../src/scan-parser';
import { fillPage } from '../src/page-actions';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionCard } from '../src/ui/QuestionDetails';

const url =
  'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
const types = ['单选', '单选', '多选', '多选', '判断', '判断'] as const;
const options = [
  ['样例选项甲', '样例选项乙', '样例选项丙', '样例选项丁'],
  ['合成选项一', '合成选项二', '合成选项三', '合成选项四'],
  ['示例选项 A', '示例选项 B', '示例选项 C', '示例选项 D'],
  ['示例属性一', '示例属性二', '示例属性三', '示例属性四'],
  ['对', '错'],
  ['对', '错'],
];

function makeQuestion(index: number) {
  const id = String(900001 + index);
  const type = types[index]!;
  const multi = type === '多选';
  const code = type === '多选' ? '1' : type === '判断' ? '3' : '0';
  const labelClass = multi ? 'num_option_dx' : 'num_option';
  const role = multi ? 'checkbox' : 'radio';
  return `<div class="TiMu newTiMu" id="question${id}" data="${code}">
    <div class="Zy_TItle clearfix"><i>${index + 1}</i><div class="clearfix fontLabel" role="option"><span class="newZy_TItle">【${type}题】</span><p>合成示例题干 ${index + 1}。</p></div></div>
    <div class="clearfix"><ul class="Zy_ulTop w-top fl">${options[index]!
      .map(
        (text, optionIndex) => `<li class="font-cxsecret before-after" onclick="${multi ? 'addMultipleChoice' : 'addChoice'}(this)" qid="${id}" qtype="${code}" role="${role}">
          <label class="fl before"><span class="${labelClass}" name="answer${id}" data="${String.fromCharCode(65 + optionIndex)}">${String.fromCharCode(65 + optionIndex)}</span></label>
          <a class="fl after"><p>${text}</p></a><div class="clear"></div>
        </li>`,
      )
      .join('')}</ul>
    <input type="hidden" name="answer${id}" id="answer${id}">
    <input type="hidden" id="answertype${id}" name="answertype${id}"></div>
  </div>`;
}

const sample = types.map((_, index) => makeQuestion(index)).join('');

describe('synthetic multi-choice page controls', () => {
  it('reads all options, including the independent multi-choice control class', () => {
    const page = extractPage(inertDocument(sample), url)!;
    expect(page.questions).toHaveLength(6);
    expect(page.questions.map((q) => q.options.length)).toEqual([
      4, 4, 4, 4, 2, 2,
    ]);
    const q = page.questions[2]!;
    expect(q.type).toBe('multiple');
    expect(q.options.map((o) => o.text)).toEqual(options[2]);
    expect(q.options.map((o) => [o.label, o.key])).toEqual([
      ['A', 'A'],
      ['B', 'B'],
      ['C', 'C'],
      ['D', 'D'],
    ]);
    expect(page.questions[3]!.options.map((o) => o.text)).toEqual(options[3]);
    expect(
      page.questions.every((q) => !q.issues.includes('选项内容或答案键不完整')),
    ).toBe(true);
    expect(page.questions.every((q) => q.existing.length === 0)).toBe(true);
  });

  it('reads changed platform keys independently of display labels', () => {
    const doc = inertDocument(sample);
    const q = doc.querySelectorAll('.TiMu')[2]!;
    const labels = q.querySelectorAll('.num_option_dx');
    ['D', 'A', 'C', 'B'].forEach((key, i) => labels[i]!.setAttribute('data', key));
    q.querySelectorAll('[role="checkbox"]').forEach((node) =>
      node.removeAttribute('role'),
    );
    (doc.getElementById('answer900003') as HTMLInputElement).value = 'DA';
    const parsed = extractPage(doc, url)!.questions[2]!;
    expect(parsed.options.map((o) => o.key)).toEqual(['D', 'A', 'C', 'B']);
    expect(parsed.existing).toEqual(['q900003:o1', 'q900003:o2']);
    expect(parsed.issues).not.toContain('选项内容或答案键不完整');
  });

  it('keeps missing or duplicate keys in review instead of guessing from labels', () => {
    const doc = inertDocument(sample);
    const q = doc.querySelectorAll('.TiMu')[2]!;
    const labels = q.querySelectorAll('.num_option_dx');
    labels[0]!.setAttribute('data', 'B');
    expect(extractPage(doc, url)!.questions[2]!.issues).toContain(
      '选项内容或答案键不完整',
    );
    labels[0]!.removeAttribute('data');
    const parsed = extractPage(doc, url)!.questions[2]!;
    expect(parsed.options).toHaveLength(4);
    expect(parsed.options[0]!.key).toBe('');
    expect(parsed.options[0]!.text).toBe('示例选项 A');
    expect(parsed.issues).toContain('选项内容或答案键不完整');
    expect(parsed.existing).toEqual([]);
  });

  it('renders the full option set when the page structure is complete', () => {
    const q = extractPage(inertDocument(sample), url)!.questions[2]!;
    const html = renderToStaticMarkup(
      createElement(QuestionCard, {
        question: q,
        busy: false,
        onAction: () => {},
        onConfirm: () => {},
      }),
    );
    const card = inertDocument(html);
    expect(
      [...card.querySelectorAll('.question-options li')].map((n) => n.textContent),
    ).toEqual(['A示例选项 A', 'B示例选项 B', 'C示例选项 C', 'D示例选项 D']);
    expect(html).not.toContain('选项内容或答案键不完整');
  });

  it('keeps an image attached to the synthetic option that contains it', () => {
    const doc = inertDocument(sample);
    const root = doc.querySelectorAll('.TiMu')[2]!;
    const option = root.querySelectorAll('li')[1]!;
    option.classList.add('font-cxsecret');
    option.querySelector('a')!.insertAdjacentHTML(
      'beforeend',
      '<img src="/synthetic-option.png">',
    );
    const q = extractPage(doc, url)!.questions[2]!;
    expect(q.options).toHaveLength(4);
    expect(q.options[1]!.obfuscated).toBe(true);
    expect(q.images?.[0]).toMatchObject({
      part: 'option',
      optionId: 'q900003:o2',
    });
    expect(q.options[1]!.text).toContain('〔图片1〕');
    expect(q.issues).toContain('题目文字识别需检查（图片待识别）');
    expect(q.issues).not.toContain('选项内容或答案键不完整');
  });

  it('keeps submitted options readable without treating display letters as write keys', () => {
    const doc = inertDocument(sample);
    const root = doc.querySelectorAll('.TiMu')[2]!;
    root.querySelectorAll('[qid]').forEach((node) => node.removeAttribute('onclick'));
    root.querySelectorAll('.num_option_dx').forEach((node) => node.removeAttribute('data'));
    root.insertAdjacentHTML('beforeend', '<div class="newAnswerBx">已提交</div>');
    const q = extractPage(doc, url)!.questions[2]!;
    expect(q.options.map((o) => o.text)).toEqual(options[2]);
    expect(q.options.map((o) => o.key)).toEqual([
      'readonly:0',
      'readonly:1',
      'readonly:2',
      'readonly:3',
    ]);
    expect(q.issues).not.toContain('选项内容或答案键不完整');
  });

  it('fills only changed synthetic controls and leaves unrelated questions untouched', async () => {
    document.documentElement.innerHTML = sample;
    (window as unknown as { happyDOM: { setURL(value: string): void } }).happyDOM.setURL(url);
    const root = document.querySelectorAll('.TiMu')[2]!;
    const labels = root.querySelectorAll('.num_option_dx');
    ['D', 'A', 'C', 'B'].forEach((key, i) => labels[i]!.setAttribute('data', key));
    const input = document.getElementById('answer900003') as HTMLInputElement;
    input.value = 'D';
    const clicks: string[] = [];
    for (const node of root.querySelectorAll<HTMLElement>('[qid]')) {
      node.addEventListener('click', () => {
        const key = node.querySelector('.num_option_dx')!.getAttribute('data')!;
        clicks.push(key);
        const selected = new Set(input.value.split(''));
        selected.has(key) ? selected.delete(key) : selected.add(key);
        input.value = [...selected].sort().join('');
        node.setAttribute('aria-checked', String(selected.has(key)));
      });
    }
    const before = extractPage(document, url)!;
    const binding = { taskKey: before.taskKey, fingerprint: before.fingerprint };
    const proposal = {
      questionId: '900003',
      optionIds: ['q900003:o1', 'q900003:o3'],
      explanation: '',
      needsReview: false,
    };
    const after = await fillPage(binding, [proposal]);
    expect(clicks).toEqual(['C']);
    expect(after.questions[2]!.existing).toEqual(proposal.optionIds);
    expect(after.questions.filter((q) => q.id !== '900003')).toEqual(
      before.questions.filter((q) => q.id !== '900003'),
    );
    await fillPage(binding, [proposal]);
    expect(clicks).toEqual(['C']);
    const changed = await fillPage(binding, [
      { ...proposal, optionIds: ['q900003:o2'] },
    ]);
    expect(changed.questions[2]!.existing).toEqual(['q900003:o2']);
    expect(clicks).toEqual(['C', 'D', 'A', 'C']);
  });
});

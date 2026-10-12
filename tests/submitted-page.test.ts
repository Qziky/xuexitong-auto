import { expect, it } from 'vitest';
import { extractPage } from '../src/page-parser';
import { inertDocument } from '../src/scan-parser';
import { exportQuestions } from '../src/question-export';

const url =
  'https://mooc1.chaoxing.com/mooc-ans/api/work?courseid=100&clazzId=200&workId=900';
const letters = ['A', 'B', 'C', 'D'];

function choiceQuestion(index: number, type: 'single' | 'boolean') {
  const id = String(900100 + index);
  const boolean = type === 'boolean';
  const choices = boolean ? ['对', '错'] : letters.map((key) => `合成选项 ${key}`);
  const answer = boolean ? 'A' : 'B';
  const code = boolean ? '3' : '0';
  const title = boolean ? '判断' : '单选';
  return `<div class="TiMu newTiMu" id="question${id}" data="${code}" typename="${title}题">
    <div class="Zy_TItle"><div class="fontLabel"><span class="newZy_TItle">【${title}题】</span><p>合成示例题干 ${index + 1}。</p></div></div>
    <input type="hidden" id="answertype${id}" name="answertype${id}">
    <input type="hidden" id="answer${id}" name="answer${id}" value="${answer}">
    <ul class="Zy_ulTop">${choices
      .map(
        (text, optionIndex) => `<li onclick="addChoice(this)" qid="${id}" qtype="${code}" role="radio">
          <span class="num_option" data="${letters[optionIndex]}">${letters[optionIndex]}</span>
          <a class="after"><p>${text}</p></a>
        </li>`,
      )
      .join('')}</ul>
    <div class="correctAnswerBx"><span class="correctAnswer">标准答案：${answer}</span></div>
  </div>`;
}

function blankQuestion(index: number) {
  const id = String(900100 + index);
  const count = index === 10 ? 1 : index === 16 ? 4 : 2;
  const values = Array.from({ length: count }, (_, blank) => `合成值-${index}-${blank + 1}`);
  return `<div class="TiMu newTiMu" id="question${id}" data="2" typename="填空题">
    <div class="Zy_TItle"><div class="fontLabel"><span class="newZy_TItle">【填空题】</span><p>合成填空示例 ${index + 1}：${values.map(() => '____').join('、')}。</p></div></div>
    ${values.map((value, blank) => `<input type="text" id="answer${id}_${blank}" value="${value}">`).join('')}
    <div class="correctAnswerBx">标准答案：${values.map((value, blank) => `<span class="correctAnswer">第${blank + 1}空：${value}</span>`).join('')}</div>
  </div>`;
}

const sample = [
  ...Array.from({ length: 10 }, (_, index) => choiceQuestion(index, 'single')),
  ...Array.from({ length: 12 }, (_, index) => blankQuestion(index + 10)),
  ...Array.from({ length: 8 }, (_, index) => choiceQuestion(index + 22, 'boolean')),
].join('');

it('parses a synthetic 30-question submitted-page layout without editable controls', () => {
  const page = extractPage(inertDocument(sample), url)!;
  expect(page.questions).toHaveLength(30);
  expect(page.questions.filter((q) => q.type === 'single')).toHaveLength(10);
  expect(page.questions.filter((q) => q.type === 'blank')).toHaveLength(12);
  expect(page.questions.filter((q) => q.type === 'boolean')).toHaveLength(8);
  expect(
    page.questions.every((q) => q.existing.length > 0 && q.publishedAnswer),
  ).toBe(true);
  expect(page.questions[0]!.options.map((o) => o.text)).toEqual([
    '合成选项 A',
    '合成选项 B',
    '合成选项 C',
    '合成选项 D',
  ]);
  expect(page.questions[0]!.existing).toEqual([
    page.questions[0]!.options[1]!.id,
  ]);
  expect(page.questions[16]!.blanks).toHaveLength(4);
  expect(page.questions[16]!.existing).toEqual([
    '合成值-16-1',
    '合成值-16-2',
    '合成值-16-3',
    '合成值-16-4',
  ]);
  expect(
    page.questions.every(
      (q) => !q.issues.some((s) => /答案键|没有选项|未找到/.test(s)),
    ),
  ).toBe(true);
});

it('keeps a synthetic published blank answer in one slot and exports own answers separately', () => {
  const page = extractPage(inertDocument(sample), url)!;
  const firstBlank = page.questions[10]!;
  expect(firstBlank.blanks).toHaveLength(1);
  expect(firstBlank.publishedAnswer?.blanks).toHaveLength(1);
  expect(firstBlank.publishedAnswer?.blanks?.[0]).toContain('合成值-10-1');
  const output = exportQuestions(page, [], { own: true }).text;
  expect(output).toContain('我的答案（网页）：');
  expect(output).not.toContain('模型参考');
});

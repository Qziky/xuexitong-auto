import { Window } from 'happy-dom';
import { expect, it } from 'vitest';
import { fontSource } from '../src/ocr';
import { extractPage } from '../src/page-parser';

const url =
  'https://mooc1.chaoxing.com/mooc-ans/work/selectWorkQuestionYiPiYue?courseId=1&classId=2&workId=3';
function sample(
  family = 'Microsoft Yahei, Arial, sans-serif',
  text = 'Visible text',
  status = 'loaded',
  fontFamilies: string[] = [],
) {
  const win = new Window({ url });
  const doc = win.document;
  doc.body.innerHTML = `<div>已完成</div><div class="TiMu" id="question1"><div class="Zy_TItle"><div class="fontLabel font-cxsecret" style="font-family:${family}"><span class="newZy_TItle">【单选题】</span>${text}</div></div><ul class="Zy_ulTop"><li><i>A、</i><a>甲</a></li><li><i>B、</i><a>乙</a></li></ul><div class="myAnswerBx">我的答案：<span class="answerCon">A</span></div></div>`;
  Object.defineProperty(doc, 'readyState', { value: 'complete' });
  Object.defineProperty(doc, 'fonts', {
    value: {
      status,
      [Symbol.iterator]: function* () {
        for (const family of fontFamilies) yield { family };
      },
    },
  });
  return { doc: doc as unknown as Document, win };
}
it('真实只读页已加载系统字体，残留类名不会触发 OCR', () => {
  const { doc } = sample();
  expect(extractPage(doc, url)!.questions[0]!.obfuscated).toBe(false);
});
it.each([
  ['secret-font', 'Visible text', 'loaded', []],
  ['Arial', 'Visible text', 'loading', []],
  ['Arial', '\uE001', 'loaded', []],
  ['Arial', 'Visible text', 'loaded', ['Arial']],
] as const)(
  '未知字体、未加载、私有字形和伪装系统字体继续检查：%s',
  (family, text, status, fonts) => {
    const { doc } = sample(family, text, status, [...fonts]);
    expect(extractPage(doc, url)!.questions[0]!.obfuscated).toBe(true);
  },
);
it('惰性解析和可编辑页不能仅凭无字体 CSS 当作明文', () => {
  const { doc } = sample();
  const editable = url.replace('selectWorkQuestionYiPiYue', 'doHomeWorkNew');
  expect(extractPage(doc, editable)!.questions[0]!.obfuscated).toBe(true);
});
it('可编辑测验中仅覆盖弯引号的本地字体不会把可读题目误判为混淆字形', () => {
  const { doc } = sample('CXChineseQuote, Arial, sans-serif');
  const style = doc.createElement('style');
  style.textContent =
    '@font-face { font-family: CXChineseQuote; src: local("PingFangSC-Regular"); unicode-range: U+2018, U+2019, U+201C, U+201D; }';
  doc.head.append(style);
  const editable = url.replace('selectWorkQuestionYiPiYue', 'doHomeWorkNew');
  expect(extractPage(doc, editable)!.questions[0]!.obfuscated).toBe(false);
});
it('仍将带私有区字符的本地引号字体题目保留为待解码', () => {
  const { doc } = sample('CXChineseQuote, Arial, sans-serif', '\uE001');
  const style = doc.createElement('style');
  style.textContent =
    '@font-face { font-family: CXChineseQuote; src: local("PingFangSC-Regular"); unicode-range: U+2018, U+2019, U+201C, U+201D; }';
  doc.head.append(style);
  const editable = url.replace('selectWorkQuestionYiPiYue', 'doHomeWorkNew');
  expect(extractPage(doc, editable)!.questions[0]!.obfuscated).toBe(true);
});
it('保留混淆字体并按页面地址解析相对资源 URL', () => {
  const { doc } = sample('secret-font');
  const style = doc.createElement('style');
  style.textContent =
    '@font-face { font-family: font-cxsecret; src: url("../font/chapter.ttf") format("truetype"); }';
  doc.head.append(style);
  const page = extractPage(doc, url)!;
  expect(page.fontCss).toContain('font-family: font-cxsecret');
  expect(fontSource(page.fontCss ?? '', page.url)).toBe(
    'https://mooc1.chaoxing.com/mooc-ans/font/chapter.ttf',
  );
});

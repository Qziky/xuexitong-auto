import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RECOGNITION, type QuestionRecord } from '../src/domain';
import { pageFormula, formulaImageContext } from '../src/formula-content';
import { extractPage } from '../src/page-parser';
import { inertDocument } from '../src/scan-parser';
import { restoreQuestionImages } from '../src/image-recognition';
import { restoreSnapshot } from '../src/ocr';

const mock = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../src/vision', () => ({
  transcribeSegments: mock.transcribe,
  resetVisionCapability: vi.fn(),
}));
const URL =
  'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=900';
const encoded = (value: string) => encodeURIComponent(JSON.stringify(value));
function fixture(optionFormula = true) {
  return extractPage(
    inertDocument(
      `<div class="questionLi" id="question10"><h3 class="mark_name"><span class="colorShallow">单选题</span>与<img class="ans-latex-moudle" data="${encoded('y=x-7')}" src="/stem.png">相同的是</h3><a onclick="addChoice()"><span class="num_option" data="D">C</span><span class="answer_p"><img ${optionFormula ? `class="ans-latex-moudle" data="${encoded('y=t-7')}"` : ''} src="/option.png"></span></a><a onclick="addChoice()"><span class="num_option" data="B">D</span><span class="answer_p">另一个选项</span></a></div>`,
    ),
    URL,
  )!;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Unexpected network request');
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('网页原始公式优先', () => {
  it('读取 URI 编码的 JSON 公式，保留变量、分式和转义命令', () => {
    const value = String.raw`y=\frac{x^2+7}{\sqrt{x+3}}`;
    const doc = inertDocument(
      `<img class="ans-latex-moudle" data="${encoded(value)}">`,
    );
    expect(pageFormula(doc.querySelector('img')!)).toBe(value);
  });
  it('缺失、损坏、非字符串或任意图片的 data 不冒充原始公式', () => {
    for (const attrs of [
      'class="ans-latex-moudle"',
      'class="ans-latex-moudle" data="%broken"',
      `class="ans-latex-moudle" data="${encodeURIComponent('{}')}"`,
      `class="ans-latex-moudle" data="${encoded('')}"`,
      `class="ans-latex-moudle" data="${encoded('〔图片1〕')}"`,
      `data="${encoded('y=x-7')}"`,
    ]) {
      const node = inertDocument(`<img ${attrs}>`).querySelector('img')!;
      expect(pageFormula(node)).toBeUndefined();
    }
  });
  it('提取时保留图片次序，原公式改变时同一图片地址也使指纹失效', () => {
    const page = fixture();
    expect(page.questions[0]!.images!.map((image) => image.latex)).toEqual([
      'y=x-7',
      'y=t-7',
    ]);
    expect(page.questions[0]!.stem).toContain('〔图片1〕');
    const doc = inertDocument(
      `<div class="questionLi" id="question10"><h3 class="mark_name">公式<img class="ans-latex-moudle" src="/same.png" data="${encoded('y=x-7')}"></h3></div>`,
    );
    const before = extractPage(doc, URL)!;
    doc.querySelector('img')!.setAttribute('data', encoded('y=x-8'));
    const after = extractPage(doc, URL)!;
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['vision-first', 'manual'] as const)(
    '原公式按网页证据确认，%s 不调用识别模型或下载图片',
    async (imageStrategy) => {
      const page = fixture();
      const raster = vi.fn();
      await restoreQuestionImages(
        page,
        { ...DEFAULT_RECOGNITION, imageStrategy },
        undefined,
        raster,
      );
      const q = page.questions[0]!;
      expect(q.stem).toBe(String.raw`与\(y=x-7\)相同的是`);
      expect(q.options[0]!.text).toBe(String.raw`\(y=t-7\)`);
      expect(q.options[0]!.key).toBe('D');
      expect(q.options[0]!.label).toBe('C');
      expect(q.recognition?.stem.source).toBe('web');
      expect(q.recognition?.options[q.options[0]!.id]?.source).toBe('web');
      expect(q.issues).toEqual([]);
      expect(mock.transcribe).not.toHaveBeenCalled();
      expect(raster).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('完整文字还原流程保留网页公式来源，不把变量重新交给 OCR 猜测', async () => {
    const restored = await restoreSnapshot(fixture(), '/ocr');
    const q = restored.questions[0]!;
    expect(q.stem).toBe(String.raw`与\(y=x-7\)相同的是`);
    expect(q.recognition?.stem.source).toBe('web');
    expect(q.recognition?.images?.['q10:image1']?.source).toBe('web');
    expect(q.issues).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(mock.transcribe).not.toHaveBeenCalled();
  });
  it('网页公式确认不解除其他混淆文字尚未确认的问题', async () => {
    const page = fixture();
    const q = page.questions[0]!;
    q.recognition = {
      stem: { attempts: [] },
      options: Object.fromEntries(
        q.options.map((o) => [o.id, { source: 'web', attempts: [] }]),
      ),
    };
    q.issues.push('混淆字体加载失败，需人工检查');
    await restoreQuestionImages(page, DEFAULT_RECOGNITION, undefined, vi.fn());
    expect(q.recognition.stem.source).toBeUndefined();
    expect(q.issues).toContain('混淆字体加载失败，需人工检查');
  });
  it('图片转录携带原始题干公式与真实选项标签，不用错误预览补全图片', () => {
    const q: QuestionRecord = fixture(false).questions[0]!;
    const context = JSON.parse(formulaImageContext(q, q.images![1]!));
    expect(context.stem).toBe(String.raw`与\(y=x-7\)相同的是`);
    expect(context.optionLabel).toBe('C');
    expect(context.surroundingText).toBe('〔图片2〕');
    expect(context.part).toBe('option');
  });
});

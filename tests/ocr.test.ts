import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER,
  DEFAULT_RECOGNITION,
  type PageSnapshot,
  type RecognitionSettings,
} from '../src/domain';
import {
  comparableText,
  validateRecognitionMarkers,
} from '../src/recognition-settings';

const mock = vi.hoisted(() => ({
  createWorker: vi.fn(),
  setParameters: vi.fn(async (_value: { tessedit_pageseg_mode: string }) => {}),
  recognize: vi.fn(),
  terminate: vi.fn(),
  transcribe: vi.fn(),
}));
vi.mock('tesseract.js', () => ({
  createWorker: mock.createWorker,
  PSM: { SINGLE_LINE: '7', SINGLE_BLOCK: '6' },
}));
vi.mock('../src/vision', () => ({
  transcribeSegments: mock.transcribe,
  resetVisionCapability: vi.fn(),
}));
let ocr: typeof import('../src/ocr');
let remapped = false;
let changedOnlyAtLargeSize = false;
let blankCanvas = false;
let unavailablePixels = false;
let chineseRemapped = true;
let drawnLines: string[] = [];

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  remapped = false;
  changedOnlyAtLargeSize = false;
  blankCanvas = false;
  unavailablePixels = false;
  chineseRemapped = true;
  drawnLines = [];
  mock.createWorker.mockResolvedValue(mock);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,AAAA',
  );
  mock.transcribe.mockImplementation(
    async (_config, segments) =>
      new Map(
        segments.map((s: { id: string }) => [
          s.id,
          { engine: 'vision', success: true, text: `视觉文字 ${s.id}` },
        ]),
      ),
  );
  mock.recognize.mockResolvedValue({
    data: { text: '还原后的文字', confidence: 96 },
  });
  // Simulate unchanged vs remapped rendered glyphs. Actual canvas/font/Tesseract
  // behavior is checked separately with the observed font in the local browser.
  const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement) {
      if (contexts.has(this)) return contexts.get(this)!;
      const context = {
        font: '',
        measureText: (value: string) => ({ width: value.length * 20 }),
        fillRect() {},
        drawImage() {},
        fillText(this: { inkText?: string }, text: string) {
          drawnLines.push(text);
          this.inkText = text;
        },
        getImageData(this: { font: string; inkText?: string }) {
          if (unavailablePixels) throw new Error('Pixel access unavailable');
          const changed =
            !this.font.includes('"Arial"') &&
            (remapped ||
              (chineseRemapped && /[\u3400-\u9fff]/.test(this.inkText ?? '')) ||
              (changedOnlyAtLargeSize && this.font.startsWith('54px')));
          return {
            data: new Uint8ClampedArray([
              blankCanvas ? 255 : changed ? 20 : 0,
              blankCanvas ? 255 : 0,
              blankCanvas ? 255 : 0,
              255,
            ]),
          };
        },
      } as unknown as CanvasRenderingContext2D;
      contexts.set(this, context);
      return context;
    },
  );
  vi.stubGlobal(
    'FontFace',
    class {
      load = vi.fn(async () => this);
    },
  );
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: vi.fn(), check: () => true, ready: Promise.resolve() },
  });
  ocr = await import('../src/ocr');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('混淆容器中的普通英文与实际文字还原', () => {
  it('合成短标签等未改变显示的内容直接保留，不依赖短词 OCR 评分', async () => {
    for (const text of ['NODE-A', 'NODE-B', 'NODE-C', 'NODE-D', 'x=3,y=4;']) {
      expect(await ocr.recognizeText(text, 'secret', '/ocr')).toMatchObject({
        text,
        reliable: true,
        confidence: 100,
      });
    }
    expect(mock.createWorker).not.toHaveBeenCalled();
    expect(mock.recognize).not.toHaveBeenCalled();
  });
  it('ASCII 字符若被字体重映射仍须 OCR，并保留不一致拦截', async () => {
    remapped = true;
    mock.recognize
      .mockResolvedValueOnce({ data: { text: '另一个选项', confidence: 98 } })
      .mockResolvedValueOnce({ data: { text: '另二个选项', confidence: 99 } });
    expect(await ocr.recognizeText('NODE-A', 'secret', '/ocr')).toMatchObject({
      reliable: false,
      reviewReason: '两次识别结果不同',
    });
    expect(mock.recognize).toHaveBeenCalledTimes(2);
  });
  it('必须两个字号都相同，不凭一次渲染跳过 OCR', async () => {
    changedOnlyAtLargeSize = true;
    await ocr.recognizeText('NODE-A', 'secret', '/ocr');
    expect(mock.recognize).toHaveBeenCalledTimes(2);
  });
  it('字体外观不同，但两次识别均与原文一致且至少 85 时保留英文原文', async () => {
    remapped = true;
    mock.recognize
      .mockResolvedValueOnce({ data: { text: 'NODE-A', confidence: 89 } })
      .mockResolvedValueOnce({ data: { text: 'NODE-A', confidence: 88 } });
    expect(await ocr.recognizeText('NODE-A', 'secret', '/ocr')).toMatchObject({
      text: 'NODE-A',
      confidence: 88,
      reliable: true,
    });
  });
  it('英文两次一致但与原文不同不使用原文佐证门槛', async () => {
    remapped = true;
    mock.recognize.mockResolvedValue({
      data: { text: 'N0DE-A', confidence: 89 },
    });
    expect(await ocr.recognizeText('NODE-A', 'secret', '/ocr')).toMatchObject({
      reliable: false,
      reviewReason: '置信度 89，低于 90',
    });
  });
  it('代码空格差异不能以原文佐证放行', async () => {
    remapped = true;
    mock.recognize.mockResolvedValue({
      data: { text: 'a+b == 3', confidence: 89 },
    });
    expect(
      await ocr.recognizeText('a + b == 3', 'secret', '/ocr'),
    ).toMatchObject({
      text: 'a+b == 3',
      reliable: false,
    });
  });
  it.each(['空白画布', '像素不可读'])(
    '%s 不视为英文显示已核实',
    async (reason) => {
      blankCanvas = reason === '空白画布';
      unavailablePixels = reason === '像素不可读';
      await ocr.recognizeText('NODE-D', 'secret', '/ocr');
      expect(mock.recognize).toHaveBeenCalledTimes(2);
    },
  );
  it('中英文混合仍使用本地双语言 OCR，保留 90 分门槛', async () => {
    mock.recognize.mockResolvedValue({
      data: { text: 'NODE-D 示例', confidence: 84 },
    });
    expect(
      await ocr.recognizeText('NODE-D 样例', 'secret', '/ocr'),
    ).toMatchObject({
      text: 'NODE-D 示例',
      reliable: false,
      reviewReason: '置信度 84，低于 90',
    });
    expect(mock.createWorker).toHaveBeenCalledWith(
      ['chi_sim', 'eng'],
      1,
      expect.objectContaining({
        workerPath: '/ocr/worker.min.js',
        workerBlobURL: false,
      }),
    );
  });
  it('还原后的中文仍要求两次一致，可忽略中文 OCR 间的空白', async () => {
    mock.recognize
      .mockResolvedValueOnce({ data: { text: '示例 文本。', confidence: 95 } })
      .mockResolvedValueOnce({ data: { text: '示例文本.', confidence: 96 } });
    expect(
      await ocr.recognizeText('合成混淆文字', 'secret', '/ocr'),
    ).toMatchObject({
      text: '示例文本。',
      reliable: true,
    });
  });
  it.each(['', ' ', '有效文本'])(
    '空 OCR 或无效评分仍进入检查：%s',
    async (text) => {
      mock.recognize.mockResolvedValue({
        data: { text, confidence: Number.NaN },
      });
      expect(
        (await ocr.recognizeText('合成混淆文字', 'secret', '/ocr'))
          .reliable,
      ).toBe(false);
    },
  );
  it('字体加载失败不放行英文，原有问题和真实选项键保留', async () => {
    vi.stubGlobal(
      'FontFace',
      class {
        load = vi.fn(async () => {
          throw new Error('Font failed');
        });
      },
    );
    const page = snapshot();
    const restored = await ocr.restoreSnapshot(page, '/ocr');
    expect(restored.questions[0]!.issues).toEqual([
      '原有问题',
      '混淆字体加载失败，需人工检查',
    ]);
    expect(restored.questions[0]!.options.map((o) => o.key)).toEqual([
      'A',
      'B',
      'D',
      'C',
    ]);
    expect(mock.recognize).not.toHaveBeenCalled();
    expect(page.questions[0]!.issues).toEqual(['原有问题']);
  });
  it('整页还原保留英文选项、答案和映射，删除传送用字体资源', async () => {
    const page = snapshot();
    const restored = await ocr.restoreSnapshot(page, '/ocr');
    expect(restored.questions[0]!.options).toEqual(page.questions[0]!.options);
    expect(restored.questions[0]!.issues).toEqual(['原有问题']);
    expect(restored.questions[0]!.existing).toEqual(['q1:o3']);
    expect(restored.fontCss).toBeUndefined();
    expect(mock.recognize).not.toHaveBeenCalled();
  });
  it('真正低置信度显示具体原因，仍阻止自动完成', async () => {
    remapped = true;
    mock.recognize.mockResolvedValue({
      data: { text: 'NODE-A', confidence: 84 },
    });
    const restored = await ocr.restoreSnapshot(snapshot(), '/ocr');
    expect(
      restored.questions[0]!.issues.some(
        (issue) =>
          issue.includes('选项 A') && issue.includes('置信度 84，低于 90'),
      ),
    ).toBe(true);
  });
});

describe('文字识别策略与有限兜底', () => {
  it('失败片段立即视觉兜底，另一片段OCR仍在运行；热缓存不重复请求', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);
    remapped = true;
    const raw = snapshot();
    raw.accountId = 'cx:1';
    raw.questions[0]!.obfuscated = false;
    raw.questions[0]!.options = raw.questions[0]!.options.slice(0, 2);
    raw.questions[0]!.options[0]!.text = '甲';
    raw.questions[0]!.options[1]!.text = '乙';
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let startedOther!: () => void;
    const otherStarted = new Promise<void>((resolve) => {
      startedOther = resolve;
    });
    mock.recognize.mockImplementation(async (canvas: HTMLCanvasElement) => {
      const text = (canvas.getContext('2d') as unknown as { inkText: string })
        .inkText;
      if (text === '甲') await otherStarted;
      if (text === '乙') {
        startedOther();
        await blocked;
      }
      return { data: { text, confidence: text === '甲' ? 70 : 96 } };
    });
    const provider = {
      ...DEFAULT_PROVIDER,
      apiKey: 'pipeline-test-placeholder',
    };
    const pending = ocr.restoreSnapshot(
      raw,
      '/ocr',
      undefined,
      undefined,
      DEFAULT_RECOGNITION,
      provider,
    );
    await vi.waitFor(() => expect(mock.transcribe).toHaveBeenCalledTimes(1));
    release();
    const page = await pending;
    expect(page.questions[0]!.recognition?.options['q1:o1']?.source).toBe(
      'vision',
    );
    expect(page.questions[0]!.recognition?.options['q1:o2']?.source).toBe(
      'ocr',
    );
    expect(mock.createWorker).toHaveBeenCalledTimes(2);
    mock.recognize.mockClear();
    mock.transcribe.mockClear();
    await ocr.restoreSnapshot(
      raw,
      '/ocr',
      undefined,
      undefined,
      DEFAULT_RECOGNITION,
      provider,
    );
    expect(mock.recognize).not.toHaveBeenCalled();
    expect(mock.transcribe).not.toHaveBeenCalled();
    await ocr.restoreSnapshot(
      raw,
      '/ocr',
      undefined,
      undefined,
      DEFAULT_RECOGNITION,
      provider,
      ['1'],
    );
    expect(mock.recognize).toHaveBeenCalledTimes(4);
  });
  it('图片公式没有混淆字体也会进入识别，合并公式并保持原有答案', async () => {
    const page = snapshot();
    const question = page.questions[0]!;
    question.obfuscated = false;
    question.options.forEach((option) => {
      option.obfuscated = false;
    });
    question.stem = '极限〔图片1〕=____。';
    question.images = [
      {
        id: 'q1:image1',
        part: 'stem',
        placeholder: '〔图片1〕',
        resourceKey: 'fixture',
        src: 'https://p.ananas.chaoxing.com/formula.png',
      },
    ];
    question.issues = ['题目文字识别需检查（图片待识别）'];
    delete page.fontCss;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
            { headers: { 'Content-Type': 'image/png' } },
          ),
      ),
    );
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 52, height: 29, close })),
    );
    mock.transcribe.mockImplementation(
      async (_config, segments) =>
        new Map(
          await Promise.all(
            segments.map(
              async (segment: {
                id: string;
                render: () => Promise<string>;
              }) => {
                await segment.render();
                return [
                  segment.id,
                  {
                    engine: 'vision',
                    success: true,
                    contentKind: 'formula',
                    text: String.raw`\(\lim_{x\to1}7\)`,
                  },
                ];
              },
            ),
          ),
        ),
    );
    const restored = await ocr.restoreSnapshot(
      page,
      '/ocr',
      undefined,
      undefined,
      DEFAULT_RECOGNITION,
      { ...DEFAULT_PROVIDER, apiKey: 'test-placeholder' },
    );
    expect(restored.questions[0]!.stem).toBe(
      String.raw`极限\(\lim_{x\to1}7\)=____。`,
    );
    expect(restored.questions[0]!.issues).toEqual([]);
    expect(restored.questions[0]!.existing).toEqual(question.existing);
    expect(restored.questions[0]!.images?.[0]?.src).toBeUndefined();
    expect(document.fonts.add).not.toHaveBeenCalled();
    expect(mock.createWorker).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(question.stem).toBe('极限〔图片1〕=____。');
  });
  it('原始图片 OCR 使用块模式并严格核对数字，关闭校验才只读取一次', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 100;
    mock.recognize
      .mockResolvedValueOnce({ data: { text: '数值 7', confidence: 95 } })
      .mockResolvedValueOnce({ data: { text: '数值 1', confidence: 95 } });
    expect(await ocr.recognizeRaster(canvas, '/ocr', true)).toMatchObject({
      success: false,
      reason: '图片 OCR 两次识别结果不同',
    });
    expect(
      mock.setParameters.mock.calls.every(
        ([params]) => params.tessedit_pageseg_mode === '6',
      ),
    ).toBe(true);
    mock.recognize.mockClear();
    expect(await ocr.recognizeRaster(canvas, '/ocr', false)).toMatchObject({
      success: true,
      text: '还原后的文字',
    });
    expect(mock.recognize).toHaveBeenCalledOnce();
  });
  it('第 21 题长题干的换行画布保留所有字符和三处填空', async () => {
    const stem =
      '合成演示系统按照预设流程接收输入数据，并检查每个处理节点的当前状态，再把任务依次分发给多个本地组件进行处理；所有步骤结束后，系统会汇总并提供三类输出结果：____、____和____。';
    const canvas = ocr.renderText(stem, 'Arial', 54);
    expect(drawnLines.length).toBeGreaterThan(1);
    expect(drawnLines.join('')).toBe(stem);
    expect(canvas.height).toBeGreaterThanOrEqual(drawnLines.length * 86 + 50);
    expect(
      (stem.match(/(?<![A-Za-z0-9])_+(?![A-Za-z0-9_])/g) ?? []).length,
    ).toBe(3);
  });
  it('第 21 题填空下划线显示长度不同但位置数一致时可通过 OCR 核验', async () => {
    const raw =
      '合成系统提供三类输出：____、____和____。';
    const decoded =
      '合成系统提供三类输出：_、________和__。';
    mock.recognize.mockResolvedValue({
      data: { text: decoded, confidence: 95 },
    });
    expect(await ocr.recognizeText(raw, 'secret', '/ocr')).toMatchObject({
      reliable: true,
      text: decoded,
      confidence: 95,
    });
  });
  it('双字号像素已确认未混淆的中文保持网页原文，不请求任何识别引擎', async () => {
    remapped = false;
    chineseRemapped = false;
    expect(
      await ocr.recognizeText('未混淆中文', 'secret', '/ocr'),
    ).toMatchObject({ text: '未混淆中文', engine: 'web', reliable: true });
    expect(mock.recognize).not.toHaveBeenCalled();
    expect(mock.transcribe).not.toHaveBeenCalled();
  });
  it.each([
    ['()', '0'],
    ['____-____', '____'],
  ])(
    '两次都误读标记 %s 为 %s 仍须检查；关闭校验按用户设置使用一次非空结果',
    async (raw, decoded) => {
      mock.recognize.mockResolvedValue({
        data: { text: decoded, confidence: 99 },
      });
      expect(await ocr.recognizeText(raw!, 'secret', '/ocr')).toMatchObject({
        reliable: false,
        reviewReason: '括号或填空标记与网页不一致',
      });
      expect(
        await ocr.recognizeText(raw!, 'secret', '/ocr', undefined, false),
      ).toMatchObject({ reliable: true, text: decoded });
    },
  );
  it('下划线长度变化按空位数量核验，空位数量变化仍需检查', async () => {
    const raw = '合成列表依次包含甲项、____、____、乙项和__。';
    const decoded = '合成列表依次包含甲项、_、______、乙项和_____。';
    mock.recognize.mockResolvedValue({
      data: { text: decoded, confidence: 96 },
    });
    expect(await ocr.recognizeText(raw, 'secret', '/ocr')).toMatchObject({
      text: decoded,
      reliable: true,
      confidence: 96,
    });

    mock.recognize.mockResolvedValue({
      data: {
        text: '合成列表依次包含甲项、_、乙项和_____。',
        confidence: 96,
      },
    });
    expect(await ocr.recognizeText(raw, 'secret', '/ocr')).toMatchObject({
      reliable: false,
      reviewReason: '括号或填空标记与网页不一致',
    });
  });
  it('第 18 题编号紧邻填空线时，OCR 忽略标记长度和相邻排版空白', async () => {
    const source =
      '合成模块的特征包括：1. ______ 2. ______ 3.稳定 4.可扩展 5. ______ 6. ______ 7.轻量 8.可组合';
    const first =
      '合成模块的特征包括：1._____2._____3.稳定4.可扩展5._____6._____7.轻量8.可组合';
    const second =
      '合成模块的特征包括：1.________ 2.___ 3.稳定 4.可扩展 5.__ 6.______ 7.轻量 8.可组合';
    const context = {
      questionType: 'blank' as const,
      part: 'stem' as const,
      blankCount: 4,
    };
    mock.recognize
      .mockResolvedValueOnce({ data: { text: first, confidence: 95 } })
      .mockResolvedValueOnce({ data: { text: second, confidence: 94 } });

    const result = await ocr.recognizeText(
      source,
      'secret',
      '/ocr',
      undefined,
      true,
      undefined,
      true,
      context,
    );

    expect(result).toMatchObject({ reliable: true, text: first });
    expect(mock.recognize).toHaveBeenCalledTimes(2);
  });
  it('第 18 题 OCR 漏掉填空线时给出数量原因，视觉结果核对真实输入位置后放行', async () => {
    const source =
      '合成模块的特征包括：1. ______ 2. ______ 3.稳定 4.可扩展 5. ______ 6. ______ 7.轻量 8.可组合';
    const recognized =
      '合成模块的特征包括：1._____2._____3.稳定4.可扩展5._____6._____7.轻量8.可组合';
    const context = {
      questionType: 'blank' as const,
      part: 'stem' as const,
      blankCount: 4,
    };
    expect(
      validateRecognitionMarkers(
        source,
        '合成模块的特征包括：1. 2. 3.稳定4.可扩展5.6.7.轻量8.可组合',
        context,
      ),
    ).toMatchObject({
      valid: false,
      reason: '填空数量不一致（期望 4 个，识别到 0 个）',
    });
    const page = snapshot();
    page.questions = [
      {
        id: 'q18',
        number: 18,
        type: 'blank',
        stem: source,
        obfuscated: true,
        options: [],
        blanks: [1, 2, 3, 4].map((number) => ({
          id: `blank-${number}`,
          kind: 'input' as const,
          value: '',
        })),
        existing: ['', '', '', ''],
        required: true,
        issues: ['原有非识别问题'],
      },
    ];
    mock.recognize.mockResolvedValue({
      data: {
        text: '合成模块的特征包括：1. 2. 3.稳定4.可扩展5.6.7.轻量8.可组合',
        confidence: 95,
      },
    });
    mock.transcribe.mockImplementation(
      async (_config, segments) =>
        new Map(
          segments.map((segment: { id: string }) => [
            segment.id,
            { engine: 'vision', success: true, text: recognized },
          ]),
        ),
    );

    const restored = await ocr.restoreSnapshot(
      page,
      '/ocr',
      undefined,
      undefined,
      DEFAULT_RECOGNITION,
      { ...DEFAULT_PROVIDER, apiKey: 'test-placeholder' },
    );

    expect(restored.questions[0]!.recognition!.stem).toMatchObject({
      source: 'vision',
      attempts: [
        {
          engine: 'ocr',
          success: false,
          reason: '填空数量不一致（期望 4 个，识别到 0 个）',
        },
        { engine: 'vision', success: true, text: recognized },
      ],
    });
    expect(restored.questions[0]!.stem).toBe(recognized);
    expect(restored.questions[0]!.issues).toEqual(['原有非识别问题']);
  });
  it('填空数量、编号顺序或括号变化继续进入检查；代码下划线仍按原文比较', () => {
    const source = '云服务：1.____2.____3.可靠性 5.____6.____';
    const context = {
      questionType: 'blank' as const,
      part: 'stem' as const,
      blankCount: 4,
    };
    expect(
      validateRecognitionMarkers(
        source,
        '云服务：1.____2.____3.可靠性 5.____',
        context,
      ).reason,
    ).toBe('填空数量不一致（期望 4 个，识别到 3 个）');
    expect(
      validateRecognitionMarkers(
        source,
        '云服务：1.____3.____3.可靠性 5.____6.____',
        context,
      ).reason,
    ).toBe('填空编号或顺序与网页不一致');
    expect(
      validateRecognitionMarkers(
        '云服务（可扩展）：1.____2.____3.可靠性 5.____6.____',
        '云服务：1.____2.____3.可靠性 5.____6.____',
        context,
      ).reason,
    ).toBe('括号与网页不一致');
    expect(comparableText('foo___bar')).not.toBe(comparableText('foo_bar'));
    expect(comparableText('x_1')).not.toBe(comparableText('x_2'));
  });
  const config = { ...DEFAULT_PROVIDER, apiKey: 'test-placeholder' };
  function encoded(): PageSnapshot {
    const page = snapshot();
    page.questions[0]!.obfuscated = true;
    return page;
  }
  async function restore(
    settings: Partial<RecognitionSettings> = {},
    signal?: AbortSignal,
  ) {
    return ocr.restoreSnapshot(
      encoded(),
      '/ocr',
      signal,
      undefined,
      { ...DEFAULT_RECOGNITION, ...settings },
      config,
    );
  }
  beforeEach(() => {
    remapped = true;
  });
  it.each(['ocr-only', 'vision-only', 'ocr-first', 'vision-first'] as const)(
    '独立策略 %s 的实际引擎调用边界',
    async (strategy) => {
      mock.recognize.mockResolvedValue({
        data: { text: '低评分', confidence: 79 },
      });
      const page = await restore({ strategy });
      expect(mock.recognize).toHaveBeenCalledTimes(
        strategy === 'vision-only' || strategy === 'vision-first' ? 0 : 10,
      );
      expect(mock.transcribe).toHaveBeenCalledTimes(
        strategy === 'ocr-only' ? 0 : 5,
      );
      for (const call of mock.transcribe.mock.calls)
        expect(call[1]).toHaveLength(1);
      expect(page.questions[0]!.recognition?.stem.source).toBe(
        strategy === 'ocr-only' ? undefined : 'vision',
      );
      expect(page.questions[0]!.issues).toEqual(
        strategy === 'ocr-only'
          ? expect.arrayContaining(['原有问题'])
          : ['原有问题'],
      );
    },
  );
  it('默认 OCR 成功时不会请求视觉，保留非识别问题和答案映射', async () => {
    const page = await restore();
    expect(mock.transcribe).not.toHaveBeenCalled();
    expect(page.questions[0]!.recognition?.stem.source).toBe('ocr');
    expect(page.questions[0]!.issues).toEqual(['原有问题']);
    expect(page.questions[0]!.options.map((o) => o.key)).toEqual([
      'A',
      'B',
      'D',
      'C',
    ]);
    expect(page.questions[0]!.existing).toEqual(['q1:o3']);
    expect(JSON.stringify(page)).not.toContain('data:image');
    expect(JSON.stringify(page)).not.toContain('base64');
  });
  it('视觉返回错误括号或填空标记不能放行，其他已确认选项和问题仍保留', async () => {
    const page = encoded();
    page.questions[0]!.stem = '混淆题干（）____';
    const restored = await ocr.restoreSnapshot(
      page,
      '/ocr',
      undefined,
      undefined,
      { ...DEFAULT_RECOGNITION, strategy: 'vision-only' },
      config,
    );
    expect(restored.questions[0]!.stem).toBe('混淆题干（）____');
    expect(restored.questions[0]!.recognition?.stem.source).toBeUndefined();
    expect(restored.questions[0]!.recognition?.stem.attempts[0]).toMatchObject({
      success: false,
      reason: '视觉识别的括号或填空标记与网页不一致',
    });
    expect(restored.questions[0]!.recognition?.options['q1:o1']?.source).toBe(
      'vision',
    );
    expect(restored.questions[0]!.issues).toContain('原有问题');
    expect(mock.recognize).not.toHaveBeenCalled();
  });
  it('视觉识别允许同一空位数量使用不同下划线长度', async () => {
    const page = encoded();
    page.questions[0]!.stem =
      '合成列表依次包含甲项、____、____、乙项和__。';
    page.questions[0]!.options.forEach((option) => {
      option.obfuscated = false;
    });
    mock.transcribe.mockResolvedValue(
      new Map([
        [
          'f1',
          {
            engine: 'vision',
            success: true,
            text: '合成列表依次包含甲项、_、______、乙项和_____。',
          },
        ],
      ]),
    );
    const restored = await ocr.restoreSnapshot(
      page,
      '/ocr',
      undefined,
      undefined,
      { ...DEFAULT_RECOGNITION, strategy: 'vision-only' },
      config,
    );
    expect(restored.questions[0]!.recognition?.stem.source).toBe('vision');
    expect(restored.questions[0]!.stem).toBe(
      '合成列表依次包含甲项、_、______、乙项和_____。',
    );
    expect(restored.questions[0]!.issues).toEqual(['原有问题']);
  });
  it('视觉优先失败后只尝试一次 OCR，两个引擎均失败则待检查', async () => {
    mock.transcribe.mockRejectedValue(new Error('视觉识别无效 JSON'));
    mock.recognize.mockResolvedValue({ data: { text: '', confidence: 95 } });
    const page = await restore({ strategy: 'vision-first' });
    expect(mock.transcribe).toHaveBeenCalledTimes(5);
    expect(mock.recognize).toHaveBeenCalledTimes(10);
    expect(
      page.questions[0]!.recognition?.stem.attempts.map((a) => a.engine),
    ).toEqual(['vision', 'ocr']);
    expect(page.questions[0]!.recognition?.stem.source).toBeUndefined();
    expect(page.questions[0]!.stem).toBe('测试题目');
    expect(
      page.questions[0]!.issues.some((s) => s.includes('文字识别需检查')),
    ).toBe(true);
  });
  it('仅 OCR 不会因失败调用视觉；关闭校验采用一次非空低评分结果', async () => {
    mock.recognize.mockResolvedValue({
      data: { text: '乙项', confidence: 79 },
    });
    const page = await restore({ strategy: 'ocr-only', validateOcr: false });
    expect(page.questions[0]!.issues).toEqual(['原有问题']);
    expect(
      page.questions[0]!.recognition?.stem.attempts[0]?.readings,
    ).toHaveLength(1);
    expect(mock.recognize).toHaveBeenCalledTimes(5);
    expect(mock.transcribe).not.toHaveBeenCalled();
  });
  it('关闭校验仍对空结果触发配置的视觉兜底', async () => {
    mock.recognize.mockResolvedValue({ data: { text: '', confidence: 99 } });
    const page = await restore({ validateOcr: false });
    expect(mock.recognize).toHaveBeenCalledTimes(5);
    expect(mock.transcribe).toHaveBeenCalledTimes(5);
    expect(mock.transcribe.mock.calls[0]![1]).toHaveLength(1);
    expect(page.questions[0]!.recognition?.stem.source).toBe('vision');
    expect(page.questions[0]!.issues).toEqual(['原有问题']);
  });
  it('将所有视觉片段交给动态池并延迟图片渲染', async () => {
    const page = await restore({
      strategy: 'vision-only',
      visionConcurrency: 2,
    });
    expect(mock.transcribe.mock.calls.map((call) => call[1].length)).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(
      mock.transcribe.mock.calls[0]![1].every(
        (segment: { image?: string; render?: () => string }) =>
          segment.image === undefined && typeof segment.render === 'function',
      ),
    ).toBe(true);
    expect(page.questions[0]!.recognition?.stem.source).toBe('vision');
  });
  it('双字号共用分行，每张多行图片均使用块模式', async () => {
    await ocr.recognizeText('长中文题干'.repeat(20), 'secret', '/ocr');
    const images = mock.recognize.mock.calls.map(
      (call) => call[0] as HTMLCanvasElement,
    );
    expect(images.map((image) => image.dataset.lines)).toEqual(['2', '2']);
    expect(
      mock.setParameters.mock.calls.map(
        (call) => call[0].tessedit_pageseg_mode,
      ),
    ).toEqual(['6', '6']);
  });
  it('取消立即终止正在进行的 OCR，不能继续第二次识别或兜底', async () => {
    const controller = new AbortController();
    mock.recognize.mockImplementation(async () => {
      controller.abort();
      return { data: { text: '取消中', confidence: 99 } };
    });
    await expect(restore({}, controller.signal)).rejects.toThrow('取消');
    expect(mock.recognize).toHaveBeenCalledOnce();
    expect(mock.transcribe).not.toHaveBeenCalled();
    expect(mock.terminate).toHaveBeenCalledOnce();
  });
  it('字体加载未返回时取消立即结束，不启动 OCR 或视觉请求', async () => {
    vi.stubGlobal(
      'FontFace',
      class {
        load = () => new Promise(() => {});
      },
    );
    const controller = new AbortController();
    const request = restore({}, controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow('取消');
    expect(mock.createWorker).not.toHaveBeenCalled();
    expect(mock.transcribe).not.toHaveBeenCalled();
  });
  it('本地 OCR 初始化未返回时取消不等待资源，旧 worker 完成后被释放', async () => {
    let resolveWorker!: (value: typeof mock) => void;
    mock.createWorker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWorker = resolve;
        }),
    );
    const controller = new AbortController();
    const request = ocr.recognizeText(
      '混淆文字',
      'secret',
      '/ocr',
      undefined,
      true,
      controller.signal,
    );
    for (let i = 0; i < 5 && !resolveWorker; i++) await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toThrow('取消');
    expect(mock.recognize).not.toHaveBeenCalled();
    resolveWorker(mock);
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.terminate).toHaveBeenCalledOnce();
  });
  it('视觉鉴权失败不在后续片段重复请求，视觉优先仍按策略尝试 OCR', async () => {
    const { ProviderError } = await import('../src/provider');
    mock.transcribe.mockRejectedValue(new ProviderError('鉴权失败', 'auth'));
    const page = await restore({ strategy: 'vision-first' });
    expect(mock.transcribe).toHaveBeenCalledOnce();
    expect(mock.recognize).toHaveBeenCalledTimes(10);
    expect(page.questions[0]!.recognition?.stem.source).toBe('ocr');
    expect(page.questions[0]!.issues).toEqual(['原有问题']);
  });
  it('一致性规则只合并标点和中文排版空白，不混淆数字、空格、符号和填空标记', () => {
    expect(comparableText('计算 机（），。“甲”‘乙’')).toBe(
      comparableText('计算机(),."甲"\'乙\''),
    );
    for (const [left, right] of [
      ['0', '()'],
      ['1946', '1956'],
      ['a + b', 'a+b'],
      ['x==y', 'x=y'],
      ['____-____', '____'],
      ['foo___bar', 'foo_bar'],
      ['( )', '()'],
    ])
      expect(comparableText(left!)).not.toBe(comparableText(right!));
    expect(comparableText('____')).toBe(comparableText('___'));
  });
});

function snapshot(): PageSnapshot {
  return {
    taskKey: '100:200:work:900',
    fingerprint: 'raw-font',
    adapter: 'legacy',
    url: 'https://mooc1.chaoxing.com/mooc-ans/api/work',
    title: '测试测验',
    status: 'pending',
    fontCss:
      "@font-face{font-family:font-cxsecret;src:url('data:application/font-ttf;base64,AAAA')}",
    questions: [
      {
        id: '1',
        number: 1,
        type: 'single',
        stem: '测试题目',
        options: ['NODE-A', 'NODE-B', 'NODE-C', 'NODE-D'].map((text, i) => ({
          id: `q1:o${i + 1}`,
          key: ['A', 'B', 'D', 'C'][i]!,
          label: String.fromCharCode(65 + i),
          text,
          obfuscated: true,
        })),
        blanks: [],
        existing: ['q1:o3'],
        required: true,
        issues: ['原有问题'],
      },
    ],
  };
}

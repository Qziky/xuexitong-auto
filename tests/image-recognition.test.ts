import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER,
  DEFAULT_RECOGNITION,
  type PageSnapshot,
  type RecognitionSettings,
} from '../src/domain';
import {
  loadImageCanvas,
  restoreQuestionImages,
} from '../src/image-recognition';
import { extractPage } from '../src/page-parser';
import { inertDocument } from '../src/scan-parser';
import { recognitionDefaults } from '../src/recognition-settings';
import { PlatformAccessError } from '../src/platform-access';
import { stripImageResources } from '../src/image-content';

const mock = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../src/vision', () => ({ transcribeSegments: mock.transcribe }));
const URL =
  'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=901';
const provider = { ...DEFAULT_PROVIDER, apiKey: 'image-test-placeholder' };
const raster = vi.fn();
let fetcher: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
let draw: ReturnType<typeof vi.fn>;
function page(): PageSnapshot {
  return {
    adapter: 'modern',
    taskKey: '100:200:work:901',
    fingerprint: 'fixture',
    url: URL,
    title: '数学作业',
    status: 'pending',
    questions: [
      {
        id: '10',
        number: 1,
        type: 'blank',
        stem: '极限〔图片1〕=____。',
        options: [],
        blanks: [{ id: 'b10', kind: 'input', value: '' }],
        existing: [''],
        required: true,
        issues: ['题目文字识别需检查（图片待识别）'],
        images: [
          {
            id: 'q10:image1',
            part: 'stem',
            placeholder: '〔图片1〕',
            src: 'https://p.ananas.chaoxing.com/math/origin.png',
            resourceKey: 'one',
          },
        ],
      },
    ],
  };
}
async function restore(
  settings: Partial<RecognitionSettings> = {},
  value = page(),
  signal?: AbortSignal,
) {
  return restoreQuestionImages(
    value,
    { ...DEFAULT_RECOGNITION, ...settings },
    provider,
    raster,
    signal,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  close = vi.fn();
  draw = vi.fn();
  fetcher = vi.fn(
    async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'image/png' },
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 52, height: 29, close })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    drawImage: draw,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
    'data:image/png;base64,AAAA',
  );
  mock.transcribe.mockImplementation(
    async (_config, segments) =>
      new Map(
        await Promise.all(
          segments.map(
            async (s: { id: string; render: () => Promise<string> }) => {
              await s.render();
              return [
                s.id,
                {
                  engine: 'vision',
                  success: true,
                  text: String.raw`\(\lim_{x\to 1}7\)`,
                  contentKind: 'formula',
                },
              ];
            },
          ),
        ),
      ),
  );
  raster.mockResolvedValue({
    engine: 'ocr',
    success: true,
    text: 'lim x 7',
    readings: [{ text: 'lim x 7', confidence: 96 }],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('题目原始图片与公式识别', () => {
  it('默认优先视觉，完整合并极限条件，不把公式下标或括号当作填空差异', async () => {
    const result = await restore();
    const q = result.questions[0]!;
    expect(q.stem).toBe(String.raw`极限\(\lim_{x\to 1}7\)=____。`);
    expect(q.recognition?.stem.source).toBe('vision');
    expect(q.issues).toEqual([]);
    expect(q.blanks).toHaveLength(1);
    expect(q.images?.[0]?.src).toBeUndefined();
    expect(raster).not.toHaveBeenCalled();
    expect(mock.transcribe.mock.calls[0]![1][0].originalImage).toBe(true);
    expect(close).toHaveBeenCalled();
  });
  it('保持题干多个图片及图片选项的次序和真实答案键', async () => {
    const p = page();
    const q = p.questions[0]!;
    q.stem = '设〔图片1〕，则〔图片2〕=____。';
    q.images!.push(
      {
        ...q.images![0]!,
        id: 'q10:image2',
        placeholder: '〔图片2〕',
        resourceKey: 'two',
      },
      {
        ...q.images![0]!,
        id: 'q10:image3',
        part: 'option',
        optionId: 'o1',
        placeholder: '〔图片3〕',
        resourceKey: 'three',
      },
    );
    q.options = [{ id: 'o1', key: 'D', label: 'A', text: '〔图片3〕' }];
    mock.transcribe.mockResolvedValue(
      new Map(
        q.images!.map((image, i) => [
          image.id,
          {
            engine: 'vision',
            success: true,
            text: String(i + 1),
            contentKind: 'formula',
          },
        ]),
      ),
    );
    const result = await restore({}, p);
    expect(result.questions[0]!.stem).toBe('设1，则2=____。');
    expect(q.options[0]).toMatchObject({ key: 'D', label: 'A', text: '3' });
    expect(q.recognition?.options.o1?.source).toBe('vision');
  });
  it.each(['vision-only', 'ocr-only', 'manual'] as const)(
    '单独策略 %s 不调用另一引擎',
    async (imageStrategy) => {
      await restore({ imageStrategy });
      expect(mock.transcribe).toHaveBeenCalledTimes(
        imageStrategy === 'vision-only' ? 1 : 0,
      );
      expect(raster).toHaveBeenCalledTimes(
        imageStrategy === 'ocr-only' ? 1 : 0,
      );
      if (imageStrategy === 'manual') expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('OCR 优先未确认数学结构时再视觉兜底，OCR 失败不阻挡最终确认', async () => {
    const result = await restore({ imageStrategy: 'ocr-first' });
    expect(raster).toHaveBeenCalledOnce();
    expect(
      result.questions[0]!.recognition?.images?.['q10:image1']?.attempts.map(
        (a) => a.success,
      ),
    ).toEqual([false, true]);
    expect(result.questions[0]!.issues).toEqual([]);
  });
  it('视觉不确定时 OCR 公式预览仍需确认，其他题结果不受影响', async () => {
    mock.transcribe.mockResolvedValue(
      new Map([
        [
          'q10:image1',
          {
            engine: 'vision',
            success: false,
            text: 'x^2',
            contentKind: 'formula',
            reason: '符号模糊',
          },
        ],
      ]),
    );
    const p = page();
    p.questions.push({
      ...structuredClone(p.questions[0]!),
      id: '20',
      images: undefined,
      stem: '普通文字',
      issues: [],
      recognition: { stem: { source: 'web', attempts: [] }, options: {} },
    });
    const result = await restore({}, p);
    expect(result.questions[0]!.recognition?.stem.source).toBeUndefined();
    expect(result.questions[0]!.issues.join()).toContain('人工确认');
    expect(result.questions[1]!.stem).toBe('普通文字');
  });
  it('图表不被文字兜底自动放行，保留非文字问题', async () => {
    mock.transcribe.mockResolvedValue(
      new Map([
        [
          'q10:image1',
          {
            engine: 'vision',
            success: false,
            contentKind: 'unsupported',
            reason: '图表',
          },
        ],
      ]),
    );
    const result = await restore();
    expect(result.questions[0]!.issues).toContain(
      '图片不是可完整转录的文字或公式，需人工处理',
    );
    expect(raster).not.toHaveBeenCalled();
  });
  it('视觉确认图片类型为文字后，可靠 OCR 兜底清除视觉警告并正确完成进度', async () => {
    mock.transcribe.mockResolvedValue(
      new Map([
        [
          'q10:image1',
          {
            engine: 'vision',
            success: false,
            contentKind: 'text',
            text: '原始图片文字',
            reason: '本次转录不确定',
          },
        ],
      ]),
    );
    const pulse = vi.fn();
    const result = await restoreQuestionImages(
      page(),
      DEFAULT_RECOGNITION,
      provider,
      raster,
      undefined,
      pulse,
    );
    expect(result.questions[0]!.recognition?.stem.source).toBe('ocr');
    expect(result.questions[0]!.issues).toEqual([]);
    expect(
      pulse.mock.calls.find(
        ([, detail]) => detail?.code === 'image-confirmed',
      )?.[1]?.done,
    ).toBe(1);
  });
  it('网页文字未确认时，成功图片不能清除原文字问题', async () => {
    const p = page();
    p.questions[0]!.recognition = { stem: { attempts: [] }, options: {} };
    p.questions[0]!.issues.push('混淆字体加载失败，需人工检查');
    const result = await restore({}, p);
    expect(result.questions[0]!.recognition?.stem.source).toBeUndefined();
    expect(result.questions[0]!.issues).toContain(
      '混淆字体加载失败，需人工检查',
    );
  });
  it('图片占位丢失时不能确认内容', async () => {
    const p = page();
    p.questions[0]!.stem = '极限=____。';
    const result = await restore({}, p);
    expect(result.questions[0]!.recognition?.stem.source).toBeUndefined();
    expect(result.questions[0]!.issues.join()).toContain('位置');
  });
  it('取消识别抛出取消错误并释放地址，不应用结果', async () => {
    const controller = new AbortController();
    controller.abort();
    const p = page();
    await expect(restore({}, p, controller.signal)).rejects.toThrow('取消');
    expect(fetcher).not.toHaveBeenCalled();
    expect(p.questions[0]!.images![0]!.src).toBeUndefined();
  });
  it('微小公式保留全部边界，并为上下标留出白边', async () => {
    const canvas = await loadImageCanvas(page().questions[0]!.images![0]!, URL);
    expect(canvas.width).toBe(232);
    expect(canvas.height).toBe(140);
    expect(draw.mock.calls[0]!.slice(1)).toEqual([12, 12, 208, 116]);
    expect(close).toHaveBeenCalledOnce();
  });
  it('外部地址、超大资源及非图片资源被拒绝', async () => {
    const image = page().questions[0]!.images![0]!;
    await expect(
      loadImageCanvas({ ...image, src: 'https://example.com/a.png' }, URL),
    ).rejects.toThrow('课程资源');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(
      new Response('x', {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '6000001' },
      }),
    );
    await expect(loadImageCanvas(image, URL)).rejects.toThrow('6 MB');
    fetcher.mockResolvedValueOnce(
      new Response('page', { headers: { 'Content-Type': 'text/html' } }),
    );
    await expect(loadImageCanvas(image, URL)).rejects.toThrow('不是受支持');
  });
  it('图片资源的限流和验证码进入平台暂停而非普通识别错误', async () => {
    const image = page().questions[0]!.images![0]!;
    fetcher.mockResolvedValueOnce(new Response('', { status: 429 }));
    await expect(loadImageCanvas(image, URL)).rejects.toBeInstanceOf(
      PlatformAccessError,
    );
    fetcher.mockResolvedValueOnce(
      new Response('【9010】操作异常，请输入图片中的验证码', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    await expect(loadImageCanvas(image, URL)).rejects.toBeInstanceOf(
      PlatformAccessError,
    );
  });
});

describe('图片数据、设置与预览页', () => {
  it('题干和选项图片按 DOM 顺序提取，不请求资源；src 清理后指纹稳定', () => {
    const doc = inertDocument(
      '<div class="questionLi" id="question10"><h3 class="mark_name"><span class="colorShallow">单选题</span>设<img src="/one.png">，则<img src="/two.png">为：</h3><a onclick="addChoice()"><span class="num_option" data="D">A</span><span class="answer_p"><img src="/three.png"></span></a><a onclick="addChoice()"><span class="num_option" data="B">B</span><span class="answer_p">普通选项</span></a></div>',
    );
    const p = extractPage(doc, URL)!;
    expect(p.questions[0]!.stem).toBe('设〔图片1〕，则〔图片2〕为：');
    expect(p.questions[0]!.images?.map((image) => image.part)).toEqual([
      'stem',
      'stem',
      'option',
    ]);
    expect(p.questions[0]!.options[0]).toMatchObject({
      id: 'q10:o1',
      key: 'D',
      text: '〔图片3〕',
    });
    const before = p.fingerprint;
    stripImageResources(p);
    expect(p.fingerprint).toBe(before);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('预览页即便题目存在也明确只读，未冒充未提交的答题页', () => {
    const p = extractPage(
      inertDocument(
        '<div class="questionLi" id="question10"><h3 class="mark_name"><span class="colorShallow">填空题</span>极限<img src="/math.png">=____。</h3></div>',
      ),
      URL.replace('dowork', 'preview'),
    )!;
    expect(p.pageMode).toBe('preview');
    expect(p.status).toBe('unknown');
    expect(p.questions).toHaveLength(1);
  });
  it('旧设置和非法图片策略补入视觉优先，显式选择保留', () => {
    expect(recognitionDefaults({}).imageStrategy).toBe('vision-first');
    expect(
      recognitionDefaults({ imageStrategy: 'bad' as never }).imageStrategy,
    ).toBe('vision-first');
    for (const imageStrategy of [
      'manual',
      'ocr-only',
      'vision-only',
      'ocr-first',
      'vision-first',
    ] as const)
      expect(recognitionDefaults({ imageStrategy }).imageStrategy).toBe(
        imageStrategy,
      );
  });
});

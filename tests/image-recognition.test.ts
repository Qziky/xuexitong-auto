import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageMaterials } from '../src/image-materials';
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
import { restoreSnapshot } from '../src/ocr';

const mock = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../src/vision', () => ({ transcribeSegments: mock.transcribe }));
const URL =
  'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=901';
const provider = { ...DEFAULT_PROVIDER, apiKey: 'image-test-placeholder' };
const raster = vi.fn();
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
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
function longImageDocument(attribute = 'data-original', inert = false) {
  const html = Array.from({ length: 33 }, (_, index) => {
    const number = index + 1;
    const image = (part: string) => {
      const source = `/math/q${number}-${part}.png`;
      return number <= 3
        ? `<img src="${source}">`
        : `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///w==" ${attribute}="${source}">`;
    };
    return `<div class="questionLi" id="question${1000 + number}"><h3 class="mark_name"><span class="colorShallow">单选题</span>函数${image('stem')}的定义域为：</h3>${[
      'D',
      'B',
      'C',
      'A',
    ]
      .map(
        (key, option) =>
          `<a onclick="addChoice()"><span class="num_option" data="${key}">${String.fromCharCode(65 + option)}</span><span class="answer_p">${image(`option${option + 1}`)}</span></a>`,
      )
      .join('')}</div>`;
  }).join('');
  return inert
    ? inertDocument(html)
    : new DOMParser().parseFromString(html, 'text/html');
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('Blob', NativeBlob);
  await imageMaterials.clear();
  close = vi.fn();
  draw = vi.fn();
  fetcher = vi.fn(
    async () =>
      new Response(PNG_BYTES, {
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
  it.each([
    {
      imageStrategy: 'ocr-only',
      kind: 'formula',
      visualText: String.raw`\(A\)`,
      confirmed: true,
    },
    {
      imageStrategy: 'vision-first',
      kind: 'formula',
      visualText: String.raw`\(A\)`,
      confirmed: true,
    },
    {
      imageStrategy: 'vision-first',
      kind: 'unsupported',
      visualText: '无法转录',
      confirmed: true,
    },
    {
      imageStrategy: 'vision-first',
      kind: 'text',
      visualText: '4',
      confirmed: false,
    },
  ] as const)(
    '单字母交叉复核：$imageStrategy / $kind / $visualText',
    async ({ imageStrategy, kind, visualText, confirmed }) => {
      vi.mocked(createImageBitmap).mockResolvedValue({
        width: 16,
        height: 18,
        close,
      } as unknown as ImageBitmap);
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
        fillRect: vi.fn(),
        drawImage: draw,
        getImageData: (
          _x: number,
          _y: number,
          width: number,
          height: number,
        ) => {
          const data = new Uint8ClampedArray(width * height * 4).fill(255);
          const rows = [
            '...##...',
            '..#..#..',
            '.#....#.',
            '.######.',
            '.#....#.',
            '.#....#.',
            '.#....#.',
          ];
          rows.forEach((row, y) =>
            [...row].forEach((pixel, x) => {
              if (pixel === '#')
                data.fill(
                  0,
                  ((y + 15) * width + x + 15) * 4,
                  ((y + 15) * width + x + 15) * 4 + 3,
                );
            }),
          );
          return { data };
        },
      } as unknown as CanvasRenderingContext2D);
      mock.transcribe.mockImplementation(async (_config, segments) => {
        await segments[0].render();
        return new Map([
          [
            'q10:image1',
            {
              engine: 'vision',
              success: false,
              contentKind: kind,
              text: visualText,
              reason: '需交叉确认',
            },
          ],
        ]);
      });
      raster.mockResolvedValue({
        engine: 'ocr',
        success: true,
        text: 'A',
        readings: [
          { text: 'A', confidence: 95 },
          { text: 'A', confidence: 96 },
        ],
      });
      const result = await restore({ imageStrategy });
      const q = result.questions[0]!;
      if (!confirmed) {
        expect(q.stem).toContain('〔图片1〕');
        expect(q.recognition?.images?.['q10:image1']?.source).toBe('image');
        expect(q.images?.[0]?.material).toBeDefined();
        return;
      }
      expect(q.stem).toBe(String.raw`极限\(A\)=____。`);
      expect(q.recognition?.images?.['q10:image1']?.source).toBe('ocr');
      expect(q.images?.[0]?.material).toBeUndefined();
      expect(q.issues).toEqual([]);
      expect(
        q.recognition?.images?.['q10:image1']?.attempts.some(
          (attempt) => attempt.engine === 'image',
        ),
      ).toBe(false);
    },
  );
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
  it('视觉与 OCR 无法可靠转录时保存原图作答，其他题结果不受影响', async () => {
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
    expect(result.questions[0]!.recognition?.stem.source).toBe('image');
    expect(result.questions[0]!.stem).toContain('〔图片1〕');
    expect(result.questions[0]!.stem).not.toContain('lim x 7');
    expect(result.questions[0]!.issues).toEqual([]);
    expect(
      await imageMaterials.read(result.questions[0]!.images![0]!.material!),
    ).toBeInstanceOf(Blob);
    expect(result.questions[1]!.stem).toBe('普通文字');
  });
  it('图表保留原图材料，不依赖 OCR 猜测文字', async () => {
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
    expect(result.questions[0]!.issues).toEqual([]);
    expect(result.questions[0]!.recognition?.stem.source).toBe('image');
    expect(result.questions[0]!.images![0]!.material?.imageId).toBe(
      'q10:image1',
    );
    expect(result.questions[0]!.images![0]!.material).not.toHaveProperty(
      'blob',
    );
    expect(result.questions[0]!.images![0]!.src).toBeUndefined();
    expect(result.questions[0]!.stem).toBe('极限〔图片1〕=____。');
    expect(raster).not.toHaveBeenCalled();
  });
  it('保存原图不解除文字识别或题目结构本身的问题', async () => {
    mock.transcribe.mockResolvedValue(new Map());
    const p = page();
    p.questions[0]!.recognition = { stem: { attempts: [] }, options: {} };
    p.questions[0]!.issues.push(
      '混淆字体加载失败，需人工检查',
      '选项内容或答案键不完整',
    );
    await restore({ imageStrategy: 'vision-only' }, p);
    expect(p.questions[0]!.images![0]!.material).toBeDefined();
    expect(p.questions[0]!.recognition?.stem.source).toBeUndefined();
    expect(p.questions[0]!.issues).toContain('混淆字体加载失败，需人工检查');
    expect(p.questions[0]!.issues).toContain('选项内容或答案键不完整');
  });
  it('没有视觉识别密钥时仍可准备原图，随后作答再检查视觉服务', async () => {
    const p = page();
    await restoreQuestionImages(
      p,
      { ...DEFAULT_RECOGNITION, imageStrategy: 'vision-only' },
      undefined,
      raster,
    );
    expect(p.questions[0]!.recognition?.stem.source).toBe('image');
    expect(p.questions[0]!.images![0]!.material).toBeDefined();
    expect(mock.transcribe).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('整页还原合并保留原图引用，生成参考时仍能读取同一份材料', async () => {
    const { restoreSnapshot } = await import('../src/ocr');
    mock.transcribe.mockResolvedValue(new Map());
    const result = await restoreSnapshot(
      page(),
      '/ocr',
      undefined,
      undefined,
      { ...DEFAULT_RECOGNITION, imageStrategy: 'vision-only' },
      provider,
    );
    const question = result.questions[0]!;
    expect(question.recognition?.stem.source).toBe('image');
    expect(question.stem).toContain('〔图片1〕');
    expect(question.images![0]!.src).toBeUndefined();
    expect(question.issues).toEqual([]);
    expect(
      (await imageMaterials.read(question.images![0]!.material!)).type,
    ).toBe('image/png');
    expect(JSON.stringify(result)).not.toMatch(/data:image|base64|"blob"/);
  });
  it('原图保存失败不能冒充材料已准备', async () => {
    mock.transcribe.mockResolvedValue(new Map());
    vi.spyOn(imageMaterials, 'save').mockRejectedValue(
      new Error('本机缓存空间不足'),
    );
    const p = page();
    await restore({ imageStrategy: 'vision-only' }, p);
    expect(p.questions[0]!.recognition?.stem.source).toBeUndefined();
    expect(p.questions[0]!.images![0]!.material).toBeUndefined();
    expect(p.questions[0]!.issues.join()).toContain('本机缓存空间不足');
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
  it.each(['p.ananas.chaoxing.com', 'p.cldisk.com'])(
    '%s 的题干和选项图片跳转后仍能转录，且不携带登录凭据',
    async (host) => {
      const p = page();
      const q = p.questions[0]!;
      q.images![0]!.src = `https://${host}/star3/origin/stem.png`;
      q.options = [{ id: 'o1', key: 'D', label: 'A', text: '〔图片2〕' }];
      q.images!.push({
        ...q.images![0]!,
        id: 'q10:image2',
        placeholder: '〔图片2〕',
        part: 'option',
        optionId: 'o1',
        src: `https://${host}/star3/origin/option.png`,
        resourceKey: 'option',
      });
      fetcher.mockImplementation(async (src: string, init: RequestInit) => {
        // The CDN returns 301 from star3/origin/*.png to star4/*/origin.png.
        // Its wildcard CORS header also rejects credentialed page requests.
        if (init.redirect !== 'follow' || init.credentials !== 'omit')
          throw new TypeError('Failed to fetch');
        return Object.defineProperty(
          new Response(PNG_BYTES, {
            headers: { 'Content-Type': 'image/png' },
          }),
          'url',
          {
            value: src.replace(
              /star3\/origin\/(.+)\.png$/,
              'star4/$1/origin.png',
            ),
          },
        );
      });
      await restore({ imageStrategy: 'vision-only' }, p);
      expect(q.recognition?.stem.source).toBe('vision');
      expect(q.recognition?.options.o1?.source).toBe('vision');
      expect(q.stem).not.toContain('〔图片');
      expect(q.options[0]!.text).not.toContain('〔图片');
      expect(q.options[0]).toMatchObject({ key: 'D', label: 'A' });
      expect(q.existing).toEqual(['']);
      expect(q.issues).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(2);
    },
  );
  it.each([
    'https://example.com/image.png',
    'http://p.ananas.chaoxing.com/image.png',
    'https://mooc1.chaoxing.com/image.png',
    'https://user@p.ananas.chaoxing.com/image.png',
  ])('拒绝 CDN 跳转到非原图片来源：%s', async (url) => {
    const response = Object.defineProperty(
      new Response(PNG_BYTES, {
        headers: { 'Content-Type': 'image/png' },
      }),
      'url',
      { value: url },
    );
    fetcher.mockResolvedValueOnce(response);
    await expect(
      loadImageCanvas(page().questions[0]!.images![0]!, URL),
    ).rejects.toThrow('图片跳转地址');
    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });
  it('需要登录的课程图片仍携带凭据，且不自动跟随跳转', async () => {
    const image = {
      ...page().questions[0]!.images![0]!,
      src: 'https://mooc1.chaoxing.com/work/attachment?id=1',
    };
    await loadImageCanvas(image, URL);
    expect(fetcher).toHaveBeenCalledWith(
      image.src,
      expect.objectContaining({ credentials: 'include', redirect: 'error' }),
    );
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
  it.each([
    'application/octet-stream, image/jpeg;charset=utf-8',
    'application/octet-stream',
    'text/plain',
    '',
  ])('公式端点的 PNG 不因错误响应头 %s 而识别失败', async (type) => {
    const p = page();
    p.questions[0]!.number = 20;
    p.questions[0]!.images![0]!.src =
      'https://mooc1.chaoxing.com/ananas/latex/p/12345';
    fetcher.mockResolvedValueOnce(
      new Response(PNG_BYTES, { headers: { 'Content-Type': type } }),
    );
    await restore({ imageStrategy: 'vision-only' }, p);
    expect(p.questions[0]!.recognition?.stem.source).toBe('vision');
    expect(p.questions[0]!.issues).toEqual([]);
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image/png' }),
    );
    expect(close).toHaveBeenCalledOnce();
  });
  it.each([
    ['image/jpeg', [255, 216, 255, 224]],
    ['image/webp', [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
  ] as const)('以文件签名确认 %s，不依赖扩展名或标注', async (type, bytes) => {
    fetcher.mockResolvedValueOnce(
      new Response(new Uint8Array(bytes), {
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    await loadImageCanvas(page().questions[0]!.images![0]!, URL);
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.objectContaining({ type }),
    );
  });
  it('没有受支持的图片签名时，不因响应头声称是 PNG 而接受', async () => {
    fetcher.mockResolvedValueOnce(
      new Response('<html>not an image</html>', {
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    await expect(
      loadImageCanvas(page().questions[0]!.images![0]!, URL),
    ).rejects.toThrow('不是受支持');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('验证码即使标成二进制图片也暂停，不送入识别', async () => {
    fetcher.mockResolvedValueOnce(
      new Response('【9010】操作异常，请输入图片中的验证码', {
        headers: { 'Content-Type': 'application/octet-stream, image/jpeg' },
      }),
    );
    await expect(
      loadImageCanvas(page().questions[0]!.images![0]!, URL),
    ).rejects.toBeInstanceOf(PlatformAccessError);
    expect(createImageBitmap).not.toHaveBeenCalled();
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
  it('cldisk 按需使用课程页返回的原始字节，不再从识别后台重复下载', async () => {
    const p = page();
    p.questions[0]!.images![0]!.src =
      'https://p.cldisk.com/star3/origin/formula.png';
    const readSource = vi.fn(
      async () => new Blob([PNG_BYTES], { type: 'image/png' }),
    );
    const result = await restoreSnapshot(
      p,
      '/ocr',
      undefined,
      undefined,
      {
        ...DEFAULT_RECOGNITION,
        imageStrategy: 'vision-only',
      },
      undefined,
      undefined,
      readSource,
    );
    expect(readSource).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    const image = result.questions[0]!.images![0]!;
    expect(image.material).toBeDefined();
    expect((await imageMaterials.read(image.material!)).size).toBe(
      PNG_BYTES.length,
    );
    expect(result.questions[0]!.issues).toEqual([]);
  });
  it('真实页面中的 cldisk 题干与选项原图进入完整识别和材料保存流程', async () => {
    const doc = new DOMParser().parseFromString(
      '<div class="questionLi" id="question10"><h3 class="mark_name"><span class="colorShallow">单选题</span>极限<img width="93" height="49" src="https://p.cldisk.com/star3/origin/stem.png" data-original="https://p.cldisk.com/star3/origin/stem.png">（）。</h3><a onclick="addChoice()"><span class="num_option" data="D">A</span><span class="answer_p"><img width="9" height="17" src="https://p.cldisk.com/star3/origin/option.png"></span></a><a onclick="addChoice()"><span class="num_option" data="B">B</span><span class="answer_p">其他选项</span></a></div>',
      'text/html',
    );
    const raw = extractPage(doc, URL)!;
    expect(raw.questions[0]!.images!.map((image) => image.src)).toEqual([
      'https://p.cldisk.com/star3/origin/stem.png',
      'https://p.cldisk.com/star3/origin/option.png',
    ]);
    // No model is configured: both originals must still be available locally.
    const result = await restoreSnapshot(raw, '/ocr', undefined, undefined, {
      ...DEFAULT_RECOGNITION,
      imageStrategy: 'vision-only',
    });
    const question = result.questions[0]!;
    expect(question.issues).toEqual([]);
    for (const image of question.images!) {
      expect(image.src).toBeUndefined();
      expect(image.material).toBeDefined();
      expect((await imageMaterials.read(image.material!)).size).toBe(
        PNG_BYTES.length,
      );
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'follow' });
    }
  });
  it.each(['data-original', 'data-src', 'data-lazy-src', '_src'])(
    '33 题的题干和选项从 %s 读取原图，不依赖滚动加载',
    (attribute) => {
      const doc = longImageDocument(attribute);
      const p = extractPage(doc, URL)!;
      expect(p.questions).toHaveLength(33);
      for (const q of p.questions) {
        expect(q.images?.map((image) => image.src)).toEqual(
          ['stem', 'option1', 'option2', 'option3', 'option4'].map(
            (part) =>
              `https://mooc1.chaoxing.com/math/q${q.number}-${part}.png`,
          ),
        );
        expect(q.options.map((option) => option.key)).toEqual([
          'D',
          'B',
          'C',
          'A',
        ]);
      }
      expect(doc.querySelectorAll(`img[${attribute}]`)).toHaveLength(150);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it('滚动加载和相对地址转绝对地址不改变题目指纹，原图变化仍使其失效', () => {
    const doc = longImageDocument();
    const before = extractPage(doc, URL)!;
    for (const image of doc.querySelectorAll('img[data-original]')) {
      image.setAttribute(
        'src',
        'https://mooc1.chaoxing.com' + image.getAttribute('data-original'),
      );
      image.removeAttribute('data-original');
    }
    expect(extractPage(doc, URL)!.fingerprint).toBe(before.fingerprint);
    doc.querySelector('#question1033 img')!.setAttribute('src', '/changed.png');
    expect(extractPage(doc, URL)!.fingerprint).not.toBe(before.fingerprint);
  });
  it('静态解析保留懒加载属性，与实时页面提取的原图及指纹一致', () => {
    const live = longImageDocument('data-src');
    const inert = longImageDocument('data-src', true);
    const last = inert.querySelector('#question1033 img')!;
    expect(last.getAttribute('src')).toBeNull();
    expect(last.getAttribute('data-src')).toBe('/math/q33-stem.png');
    const expected = extractPage(live, URL)!;
    const actual = extractPage(inert, URL)!;
    expect(actual.fingerprint).toBe(expected.fingerprint);
    expect(
      actual.questions.flatMap((q) => q.images!.map((image) => image.src)),
    ).toEqual(
      expected.questions.flatMap((q) => q.images!.map((image) => image.src)),
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    '<img>',
    '<img src="">',
    '<img src="   ">',
    '<img data-original=" " src="">',
    '<img data-original="https://images.example/original.png" src="javascript:alert(1)">',
    '<img data-src="http://p.ananas.chaoxing.com/original.png">',
    '<img data-original="data:image/svg+xml;base64,AAAA">',
  ])('缺失或不受支持的地址不会作为原图读取：%s', (html) => {
    const p = extractPage(
      inertDocument(
        `<div class="questionLi" id="question10"><h3 class="mark_name">题干${html}</h3></div>`,
      ),
      URL,
    )!;
    expect(p.questions[0]!.images?.[0]?.src).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('懒加载地址不可用时仍可读取页面上有效的原图地址', () => {
    const p = extractPage(
      inertDocument(
        '<div class="questionLi" id="question10"><h3 class="mark_name">题干<img data-original="https://images.example/other.png" src="/original.png"></h3></div>',
      ),
      URL,
    )!;
    expect(p.questions[0]!.images?.[0]?.src).toBe(
      'https://mooc1.chaoxing.com/original.png',
    );
  });
  it('完整识别流程能保存长作业末尾的原图材料，无需先滚动网页', async () => {
    mock.transcribe.mockImplementation(async (_config, segments) => {
      const results = new Map();
      for (const segment of segments) {
        await segment.render();
        results.set(segment.id, {
          engine: 'vision',
          success: false,
          contentKind: 'unsupported',
          reason: '图形需结合原图作答',
        });
      }
      return results;
    });
    const raw = extractPage(longImageDocument(), URL)!;
    const sources = raw.questions.flatMap((q) =>
      q.images!.map((image) => image.src),
    );
    const result = await restoreSnapshot(
      raw,
      '/ocr',
      undefined,
      undefined,
      { ...DEFAULT_RECOGNITION, imageStrategy: 'vision-only' },
      provider,
    );
    expect(fetcher).toHaveBeenCalledTimes(165);
    expect(fetcher.mock.calls.map(([source]) => source).sort()).toEqual(
      sources.sort(),
    );
    for (const q of result.questions) {
      expect(q.issues).toEqual([]);
      for (const image of q.images!) {
        expect(image.src).toBeUndefined();
        expect(image.material?.imageId).toBe(image.id);
        expect(q.recognition?.images?.[image.id]?.source).toBe('image');
      }
    }
    const last = result.questions.at(-1)!.images!.at(-1)!;
    expect((await imageMaterials.read(last.material!)).size).toBe(
      PNG_BYTES.length,
    );
  });
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

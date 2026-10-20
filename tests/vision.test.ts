import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER } from '../src/domain';
import {
  parseTranscription,
  transcribeSegments,
  resetVisionCapability,
} from '../src/vision';
import { chat, configureAnswerConcurrency } from '../src/provider';
import { PlatformAccessError, platformBlockFor } from '../src/platform-access';

const config = {
  ...DEFAULT_PROVIDER,
  apiKey: 'vision-test-placeholder',
  timeoutSec: 15,
};
const images = [{ id: 'f1', image: 'data:image/png;base64,AAAA' }];
const ok = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const json = (segments: unknown[]) => JSON.stringify({ segments });
afterEach(() => {
  configureAnswerConcurrency(3);
  resetVisionCapability(config);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('视觉文字转录接口', () => {
  it('原始图片使用公式转录提示，保留 LaTeX 结构且必须返回内容类型', async () => {
    const text = String.raw`\(\lim_{x\to1}\frac{x^2-1}{x-1}\)`;
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        ok(json([{ id: 'f1', kind: 'formula', text, needsReview: false }])),
      );
    vi.stubGlobal('fetch', fetcher);
    const result = await transcribeSegments(config, [
      { ...images[0]!, originalImage: true },
    ]);
    expect(result.get('f1')).toMatchObject({
      success: true,
      contentKind: 'formula',
      text,
    });
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.messages[0].content).toContain('极限趋近条件');
    expect(body.messages[0].content).toContain('不化简');
    expect(() =>
      parseTranscription(
        json([{ id: 'f1', text, needsReview: false }]),
        ['f1'],
        true,
      ),
    ).toThrow('内容类型');
    expect(
      parseTranscription(
        json([
          { id: 'f1', kind: 'unsupported', text: '图表', needsReview: false },
        ]),
        ['f1'],
        true,
      ).get('f1')?.success,
    ).toBe(false);
  });
  it('异步图片加载期间取消后，不发送模型请求或渲染下一图片', async () => {
    let finish!: (image: string) => void;
    let renderSignal: AbortSignal | undefined;
    const firstRender = vi.fn((signal?: AbortSignal) => {
      renderSignal = signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const nextRender = vi.fn(() => 'data:image/png;base64,AAAA');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const cancel = new AbortController();
    const pending = transcribeSegments(
      config,
      [
        { id: 'f1', render: firstRender },
        { id: 'f2', render: nextRender },
      ],
      cancel.signal,
      undefined,
      1,
    );
    await vi.waitFor(() => expect(firstRender).toHaveBeenCalledOnce());
    cancel.abort();
    expect(renderSignal?.aborted).toBe(true);
    finish('data:image/png;base64,AAAA');
    await expect(pending).rejects.toThrow('取消');
    expect(nextRender).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('图片加载返回平台验证时停止后续派发，并将暂停原因传回后台', async () => {
    const nextRender = vi.fn(() => 'data:image/png;base64,AAAA');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      transcribeSegments(
        config,
        [
          {
            id: 'f1',
            render: async () => {
              throw new PlatformAccessError(
                platformBlockFor(
                  'https://mooc1.chaoxing.com/antispiderShowVerify.ac',
                ),
              );
            },
          },
          { id: 'f2', render: nextRender },
        ],
        undefined,
        undefined,
        1,
      ),
    ).rejects.toBeInstanceOf(PlatformAccessError);
    expect(nextRender).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('发送 Base64 图片、片段 ID 和单独转录规则，不发送原始乱码或解题指令', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        ok(json([{ id: 'f1', text: '示例短词', needsReview: false }])),
      );
    vi.stubGlobal('fetch', fetch);
    expect((await transcribeSegments(config, images)).get('f1')).toMatchObject({
      success: true,
      text: '示例短词',
    });
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: '片段 ID：f1' },
      { type: 'image_url', image_url: { url: images[0]!.image } },
    ]);
    expect(body.messages[0].content).toContain('不解题');
    expect(body.messages[0].content).toContain('不补写');
    expect(body.response_format).toBeUndefined();
  });
  it.each([
    'not json',
    json([]),
    json([{ id: 'other', text: '甲', needsReview: false }]),
    json([{ id: 'f1', text: '甲' }]),
    json([{ id: 'f1', text: 123, needsReview: false }]),
  ])('拒绝无效格式、缺项及 ID 不匹配：%s', (content) => {
    expect(() => parseTranscription(content, ['f1'])).toThrow();
  });
  it('每张图片单独请求，响应 ID 绑定唯一片段，避免题干与选项串位', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        ok(json([{ id: 'f1', text: '长题干', needsReview: false }])),
      )
      .mockResolvedValueOnce(
        ok(json([{ id: 'f2', text: '合成标签', needsReview: false }])),
      );
    vi.stubGlobal('fetch', fetch);
    const result = await transcribeSegments(config, [
      images[0]!,
      { id: 'f2', image: 'data:image/png;base64,BBBB' },
    ]);
    expect([...result].map(([id, value]) => [id, value.text])).toEqual([
      ['f1', '长题干'],
      ['f2', '合成标签'],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [index, call] of fetch.mock.calls.entries()) {
      const content = JSON.parse(call[1].body).messages[1].content;
      expect(
        content.filter((part: { type: string }) => part.type === 'image_url'),
      ).toHaveLength(1);
      expect(content[0].text).toBe(`片段 ID：f${index + 1}`);
    }
  });
  it('多模态明确标记不确定时保留转录预览并进入人工检查', () => {
    expect(
      parseTranscription(
        json([
          {
            id: 'f1',
            text: '合成系统提供三类输出：_、_和_。',
            needsReview: true,
          },
        ]),
        ['f1'],
      ).get('f1'),
    ).toMatchObject({
      engine: 'vision',
      success: false,
      text: '合成系统提供三类输出：_、_和_。',
      reason: '视觉模型表示文字无法可靠确认',
    });
  });
  it('重复和多余 ID 不放行，空文本或不确定只让该片段失败', () => {
    expect(() =>
      parseTranscription(
        json([
          { id: 'f1', text: '甲', needsReview: false },
          { id: 'f1', text: '乙', needsReview: false },
        ]),
        ['f1', 'f2'],
      ),
    ).toThrow('ID');
    const result = parseTranscription(
      json([
        { id: 'f1', text: '', needsReview: false },
        { id: 'f2', text: '乙', needsReview: true },
        { id: 'f3', text: '丙', needsReview: false },
      ]),
      ['f1', 'f2', 'f3'],
    );
    expect([...result.values()].map((v) => v.success)).toEqual([
      false,
      false,
      true,
    ]);
  });
  it('已确认不支持图片的配置不会反复请求，新配置或主动测试可再次检测', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(
            'model does not support image inputs; reflected-secret',
            { status: 400 },
          ),
      );
    vi.stubGlobal('fetch', fetch);
    const first = await transcribeSegments(config, images);
    expect(first.blocked?.code).toBe('image-unsupported');
    expect(first.get('f1')?.reason).toContain('不支持图片');
    const cached = await transcribeSegments(config, images);
    expect(cached.blocked?.message).toContain('已确认');
    expect(fetch).toHaveBeenCalledOnce();
    const sameCapability = await transcribeSegments(
      { ...config, timeoutSec: 45 },
      images,
    );
    expect(sameCapability.blocked?.message).toContain('已确认');
    expect(fetch).toHaveBeenCalledOnce();
    const anotherModel = await transcribeSegments(
      { ...config, model: 'another' },
      images,
    );
    expect(anotherModel.blocked?.code).toBe('image-unsupported');
    resetVisionCapability(config);
    expect((await transcribeSegments(config, images)).blocked?.code).toBe(
      'image-unsupported',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('普通坏请求不误缓存为不支持图片，认证失败不泄漏服务响应', async () => {
    const fetch = vi
      .fn()
      .mockImplementation(
        async () => new Response('invalid temperature', { status: 400 }),
      );
    vi.stubGlobal('fetch', fetch);
    const invalid = await transcribeSegments(config, images);
    expect(invalid.get('f1')?.reason).toContain('HTTP 400');
    expect(invalid.blocked).toBeUndefined();
    const invalidAgain = await transcribeSegments(config, images);
    expect(invalidAgain.get('f1')?.reason).toContain('HTTP 400');
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementation(
      async () => new Response('secret-credential', { status: 401 }),
    );
    expect((await transcribeSegments(config, images)).blocked?.code).toBe(
      'auth',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([429, 503])('HTTP %s 保持最多两次临时重试', async (status) => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementation(async () => new Response('', { status }));
    vi.stubGlobal('fetch', fetch);
    const request = transcribeSegments(config, images);
    await vi.runAllTimersAsync();
    const result = await request;
    if (status === 429) expect(result.blocked?.code).toBe('rate');
    else expect(result.blocked?.code).toBe('response');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('请求超时保持重试上限，取消不继续重试', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const timed = transcribeSegments(config, images);
    await vi.runAllTimersAsync();
    expect((await timed).blocked?.code).toBe('timeout');
    expect(fetch).toHaveBeenCalledTimes(3);
    const abort = new AbortController();
    abort.abort();
    fetch.mockClear();
    await expect(
      transcribeSegments(config, images, abort.signal),
    ).rejects.toThrow('取消');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('识图请求并发不超过设置值，两个识别任务共用全局上限', async () => {
    let active = 0;
    let peak = 0;
    const progress: (number | undefined)[] = [];
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      active++;
      peak = Math.max(peak, active);
      const body = JSON.parse(options.body);
      const id = body.messages[1].content[0].text.replace('片段 ID：', '');
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return ok(json([{ id, text: '已识别', needsReview: false }]));
    });
    vi.stubGlobal('fetch', fetch);
    const makeImages = (prefix: string) =>
      Array.from({ length: 4 }, (_, index) => ({
        id: prefix + index,
        image: 'data:image/png;base64,AAAA',
      }));
    const [first, second] = await Promise.all([
      transcribeSegments(
        config,
        makeImages('a'),
        undefined,
        (_note, detail) => progress.push(detail?.active),
        2,
      ),
      transcribeSegments(
        config,
        makeImages('b'),
        undefined,
        (_note, detail) => progress.push(detail?.active),
        2,
      ),
    ]);
    expect(peak).toBe(2);
    expect(progress).toContain(2);
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(first.size).toBe(4);
    expect(second.size).toBe(4);
  });
  it('一个请求完成后立即动态补位，不等待同批的慢请求', async () => {
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const held = new Map<string, () => void>();
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      active++;
      peak = Math.max(peak, active);
      const body = JSON.parse(options.body);
      const id = body.messages[1].content[0].text.replace('片段 ID：', '');
      started.push(id);
      if (/^f[1-5]$/.test(id))
        return new Promise<Response>((resolve) => {
          held.set(id, () => {
            active--;
            resolve(ok(json([{ id, text: id, needsReview: false }])));
          });
        });
      active--;
      return ok(json([{ id, text: id, needsReview: false }]));
    });
    vi.stubGlobal('fetch', fetch);
    const pending = transcribeSegments(
      config,
      Array.from({ length: 10 }, (_, index) => ({
        id: 'f' + (index + 1),
        image: 'data:image/png;base64,AAAA',
      })),
      undefined,
      undefined,
      5,
    );
    await vi.waitFor(() => expect(started).toHaveLength(5));
    held.get('f2')!();
    await vi.waitFor(() => expect(started).toContain('f6'));
    expect(held.has('f1')).toBe(true);
    expect(started[5]).toBe('f6');
    for (const id of ['f1', 'f3', 'f4', 'f5']) held.get(id)!();
    expect((await pending).size).toBe(10);
    expect(peak).toBe(5);
  });
  it('只有取得全局名额后才渲染图片，释放名额后再渲染下一个', async () => {
    let finishFirst!: (value: Response) => void;
    const firstRender = vi.fn(() => 'data:image/png;base64,AAAA');
    const secondRender = vi.fn(() => 'data:image/png;base64,BBBB');
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => (finishFirst = resolve)),
      )
      .mockImplementation(async (_url, options) => {
        const body = JSON.parse(options.body);
        const id = body.messages[1].content[0].text.replace('片段 ID：', '');
        return ok(json([{ id, text: id, needsReview: false }]));
      });
    vi.stubGlobal('fetch', fetch);
    const pending = transcribeSegments(
      config,
      [
        { id: 'f1', render: firstRender },
        { id: 'f2', render: secondRender },
      ],
      undefined,
      undefined,
      1,
    );
    await vi.waitFor(() => expect(firstRender).toHaveBeenCalledOnce());
    expect(secondRender).not.toHaveBeenCalled();
    finishFirst(ok(json([{ id: 'f1', text: 'f1', needsReview: false }])));
    await vi.waitFor(() => expect(secondRender).toHaveBeenCalledOnce());
    expect((await pending).size).toBe(2);
  });
  it('允许 128 个并发，任务片段总数可以超过并发上限', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let peak = 0;
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      active++;
      peak = Math.max(peak, active);
      const body = JSON.parse(options.body);
      const id = body.messages[1].content[0].text.replace('片段 ID：', '');
      await gate;
      active--;
      return ok(json([{ id, text: '已识别', needsReview: false }]));
    });
    vi.stubGlobal('fetch', fetch);
    const many = Array.from({ length: 128 }, (_, index) => ({
      id: 'f' + index,
      image: 'data:image/png;base64,AAAA',
    }));
    const pending = transcribeSegments(config, many, undefined, undefined, 128);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(128));
    release();
    expect((await pending).size).toBe(128);
    expect(peak).toBe(128);
    fetch.mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      const id = body.messages[1].content[0].text.replace('片段 ID：', '');
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return ok(json([{ id, text: '已识别', needsReview: false }]));
    });
    peak = 0;
    fetch.mockClear();
    const overflow = Array.from({ length: 129 }, (_, index) => ({
      id: 'g' + index,
      image: 'data:image/png;base64,AAAA',
    }));
    expect(
      (await transcribeSegments(config, overflow, undefined, undefined, 5))
        .size,
    ).toBe(129);
    expect(fetch).toHaveBeenCalledTimes(129);
    expect(peak).toBeLessThanOrEqual(5);
  });
  it('服务级错误停止启动后续片段，并保留已成功结果', async () => {
    const fetch = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      const id = body.messages[1].content[0].text.replace('片段 ID：', '');
      if (id === 'f2') return new Response('credential', { status: 401 });
      return ok(json([{ id, text: '已识别', needsReview: false }]));
    });
    vi.stubGlobal('fetch', fetch);
    const result = await transcribeSegments(
      config,
      Array.from({ length: 5 }, (_, index) => ({
        id: 'f' + (index + 1),
        image: 'data:image/png;base64,AAAA',
      })),
      undefined,
      undefined,
      2,
    );
    expect(result.get('f1')?.success).toBe(true);
    expect(result.blocked?.code).toBe('auth');
    expect(result.size).toBe(5);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.get('f5')?.success).toBe(false);
  });
  it('等待全局识图额度时取消会移除排队请求', async () => {
    let finishFirst!: (value: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishFirst = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const first = transcribeSegments(config, images, undefined, undefined, 1);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const abort = new AbortController();
    const queued = transcribeSegments(
      config,
      [{ id: 'f2', image: 'data:image/png;base64,BBBB' }],
      abort.signal,
      undefined,
      1,
    );
    abort.abort();
    await expect(queued).rejects.toThrow('取消');
    expect(fetch).toHaveBeenCalledOnce();
    finishFirst(ok(json([{ id: 'f1', text: '文字', needsReview: false }])));
    await first;
  });
  it.each([1, 2])('视觉通道独立，答题按配置的 %i 路并发执行', async limit => {
    configureAnswerConcurrency(limit);
    let finishVision!: (value: Response) => void;
    let finishFirstAnswer!: (value: Response) => void;
    const fetch = vi.fn().mockImplementation((_url, options) => {
      const body = JSON.parse(options.body);
      const content = body.messages.at(-1).content;
      if (Array.isArray(content))
        return new Promise<Response>((resolve) => {
          finishVision = resolve;
        });
      if (content === '答题一')
        return new Promise<Response>((resolve) => {
          finishFirstAnswer = resolve;
        });
      return Promise.resolve(ok('答题二完成'));
    });
    vi.stubGlobal('fetch', fetch);
    const vision = transcribeSegments(config, images);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const first = chat(config, [{ role: 'user', content: '答题一' }]);
    const second = chat(config, [{ role: 'user', content: '答题二' }]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(limit === 1 ? 2 : 3));
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(limit === 1 ? 2 : 3);
    finishVision(ok(json([{ id: 'f1', text: '文字', needsReview: false }])));
    await vision;
    finishFirstAnswer(ok('答题一完成'));
    await expect(first).resolves.toBe('答题一完成');
    await expect(second).resolves.toBe('答题二完成');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

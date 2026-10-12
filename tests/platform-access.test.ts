import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  detectVerification,
  retryAfterTime,
  RequestPacer,
  PlatformAccessError,
} from '../src/platform-access';
import { inertDocument, parseScanDocument } from '../src/scan-parser';
import { readPageStatus } from '../src/page-parser';
import { PlatformReader } from '../src/platform-reader';

const URL =
  'https://mooc1.chaoxing.com/mooc2/work/list?courseId=100&classId=200';
const VERIFY_URL = 'https://mooc1.chaoxing.com/antispiderShowVerify.ac';
const VERIFY_HTML =
  '<h1>【9010】操作异常，请输入图片中的验证码</h1><input name="code"><img src="/verify.jpg">';
function response(
  html: string,
  url = URL,
  status = 200,
  headers: Record<string, string> = {},
) {
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    text: async () => html,
  } as Response;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('平台人工验证和限流', () => {
  it('验证码覆盖层保留题目 DOM 时报告拦截，改用变更监听而非定时提取', async () => {
    vi.stubGlobal('defineContentScript', (definition: unknown) => definition);
    vi.stubGlobal('location', {
      href: 'https://mooc1.chaoxing.com/mooc2/work/task?courseId=100&classId=200&workId=1',
    });
    const sendMessage = vi.fn(async () => ({}));
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'fixture-extension',
        sendMessage,
        onMessage: { addListener: vi.fn() },
      },
    });
    document.body.innerHTML =
      VERIFY_HTML +
      '<div class="questionLi" data-questionid="1"><div class="question-title">原题目</div></div>';
    const setInterval = vi.fn();
    let cleanup: (() => void) | undefined;
    try {
      const content = await import('../entrypoints/chaoxing.content');
      await content.default.main!({
        setInterval,
        setTimeout: window.setTimeout.bind(window),
        onInvalidated: (fn: () => void) => {
          cleanup = fn;
        },
      } as any);
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'frame-ready',
          info: expect.objectContaining({
            verificationRequired: true,
            revision: undefined,
          }),
        }),
      );
      expect(setInterval).not.toHaveBeenCalled();
    } finally {
      cleanup?.();
      document.body.innerHTML = '';
    }
  });
  it('列表读取目的拒绝章节与题目地址，重定向到题目也不会交给解析器', async () => {
    const reader = new PlatformReader();
    const fetchMock = vi.fn(async () =>
      response(
        '<div class="questionLi">题目</div>',
        'https://mooc1.chaoxing.com/mooc2/work/task?workId=1',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      reader.read(
        'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?courseid=100&knowledgeid=200',
        new AbortController().signal,
        'cx:1',
        false,
        'homework-list',
      ),
    ).rejects.toThrow(/允许/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      reader.read(
        'https://mooc1.chaoxing.com/mooc2/work/list?courseId=1',
        new AbortController().signal,
        'cx:1',
        false,
        'homework-list',
      ),
    ).rejects.toThrow(/超出/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('识别实际验证码地址及 200 响应中的 9010 页面，不把题目中的说明当成拦截', () => {
    expect(detectVerification(VERIFY_URL)?.kind).toBe('captcha');
    expect(detectVerification(URL, inertDocument(VERIFY_HTML))?.kind).toBe(
      'captcha',
    );
    expect(
      detectVerification(
        URL,
        inertDocument(
          `<div class="questionLi">${VERIFY_HTML}</div><script>${VERIFY_HTML}</script>`,
        ),
      ),
    ).toBeUndefined();
    expect(
      detectVerification('https://example.test/antispiderShowVerify.ac'),
    ).toBeUndefined();
    expect(() =>
      parseScanDocument(inertDocument(VERIFY_HTML), URL, 'cx:1'),
    ).toThrow(PlatformAccessError);
    expect(() => readPageStatus(inertDocument(VERIFY_HTML), URL)).toThrow(
      PlatformAccessError,
    );
  });
  it('按照 Retry-After 的秒数、日期或默认冷却时间等待', () => {
    expect(retryAfterTime('120', 100000)).toBe(220000);
    const at = Date.parse('2026-10-07T08:00:00Z');
    expect(retryAfterTime('Wed, 07 Oct 2026 08:05:00 GMT', at)).toBe(
      at + 300000,
    );
    expect(retryAfterTime(null, at)).toBe(at + 600000);
  });
  it('并发申请按一秒间隔放行，取消等待不发请求', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pacer = new RequestPacer();
    const starts: number[] = [];
    await pacer.wait().then(() => starts.push(Date.now()));
    const second = pacer.wait().then(() => starts.push(Date.now()));
    const third = pacer.wait().then(() => starts.push(Date.now()));
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([0, 1000]);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([second, third]);
    expect(starts).toEqual([0, 1000, 2000]);
    const controller = new AbortController();
    const canceled = expect(pacer.wait(controller.signal)).rejects.toThrow(
      /取消/,
    );
    await Promise.resolve();
    controller.abort();
    await canceled;
  });
});
describe('只读请求缓存和拦截响应', () => {
  it('同账号五分钟内复用成功结果，换号和 fresh 核验强制重新读取', async () => {
    const fetcher = vi.fn(async () => response('<div>目录</div>'));
    vi.stubGlobal('fetch', fetcher);
    const reader = new PlatformReader();
    const signal = new AbortController().signal;
    await reader.read(URL, signal, 'cx:1');
    await reader.read(URL, signal, 'cx:1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await reader.read(URL, signal, 'cx:1', true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await reader.read(URL, signal, 'cx:2');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('跳转验证码或正文验证不会被当作成功，也不会缓存到后续读取', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(VERIFY_HTML, VERIFY_URL))
      .mockResolvedValueOnce(response(VERIFY_HTML))
      .mockResolvedValue(response('<div>正常目录</div>'));
    vi.stubGlobal('fetch', fetcher);
    const reader = new PlatformReader();
    const signal = new AbortController().signal;
    await expect(reader.read(URL, signal, 'cx:1')).rejects.toThrow(
      PlatformAccessError,
    );
    await expect(reader.read(URL, signal, 'cx:1')).rejects.toThrow(
      PlatformAccessError,
    );
    expect((await reader.read(URL, signal, 'cx:1')).html).toContain('正常目录');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('429 限流保留等待时间，不立即重试；异常和取消不写缓存', async () => {
    const fetcher = vi.fn(async () =>
      response('限流', URL, 429, { 'Retry-After': '120' }),
    );
    vi.stubGlobal('fetch', fetcher);
    const reader = new PlatformReader();
    const signal = new AbortController().signal;
    await expect(reader.read(URL, signal, 'cx:1')).rejects.toMatchObject({
      block: { kind: 'rate-limit' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read(URL, controller.signal, 'cx:1')).rejects.toThrow(
      /取消/,
    );
    await expect(
      reader.read('https://example.test/dowork', signal, 'cx:1'),
    ).rejects.toThrow(/范围/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('换号后迟到的旧账号响应不会写入新账号缓存', async () => {
    let finishOld!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue(response('<div>新账号目录</div>'));
    vi.stubGlobal('fetch', fetcher);
    const reader = new PlatformReader();
    const signal = new AbortController().signal;
    const oldRead = reader.read(URL, signal, 'cx:1');
    await Promise.resolve();
    await reader.read(URL, signal, 'cx:2');
    finishOld(response('<div>旧账号目录</div>'));
    await oldRead;
    expect((await reader.read(URL, signal, 'cx:2')).html).toContain('新账号');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chat, solveBatch } from '../src/provider';
import { DEFAULT_PROVIDER, type QuestionRecord } from '../src/domain';
const config = {
  ...DEFAULT_PROVIDER,
  apiKey: 'test-only-placeholder',
  timeoutSec: 15,
};
const q: QuestionRecord = {
  id: '1',
  number: 1,
  type: 'single',
  stem: '1+1=?',
  options: [
    { id: 'q1:o1', key: 'D', label: 'A', text: '2' },
    { id: 'q1:o2', key: 'A', label: 'B', text: '3' },
  ],
  existing: [],
  blanks: [],
  issues: [],
  required: true,
};
const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('通用模型兼容层', () => {
  it('发送普通 JSON 提示和正确认证头，题目不包含真实键或账号信息', async () => {
    const mock = vi.fn().mockResolvedValue(
      ok(
        JSON.stringify({
          answers: [
            {
              questionId: '1',
              optionIds: ['q1:o1'],
              explanation: '加法',
              needsReview: false,
            },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', mock);
    const a = await solveBatch(config, [q], 'preserve');
    expect(a[0]!.optionIds).toEqual(['q1:o1']);
    const [url, options] = mock.mock.calls[0]!;
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    const body = JSON.parse(options.body);
    expect(body.response_format).toBeUndefined();
    expect(body.messages[1].content).not.toContain('"key"');
    expect(body.stream).toBe(false);
    expect(options.headers.Authorization).toBe('Bearer test-only-placeholder');
    expect(options.redirect).toBe('error');
  });
  it('支持 api-key 认证、文本 content 数组和自定义模型名称', async () => {
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: [{ type: 'text', text: 'OK' }] } }],
        }),
      ),
    );
    vi.stubGlobal('fetch', mock);
    expect(
      await chat({ ...config, auth: 'api-key', model: 'custom-model' }, [
        { role: 'user', content: 'test' },
      ]),
    ).toBe('OK');
    expect(mock.mock.calls[0]![1].headers['api-key']).toBe(config.apiKey);
  });
  it('无效答案只修复一次，继续无效则等待人工处理', async () => {
    const mock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(ok('not json')));
    vi.stubGlobal('fetch', mock);
    await expect(solveBatch(config, [q], 'preserve')).rejects.toThrow(
      '格式修复后',
    );
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('鉴权失败不重试，也不泄漏服务器响应中的凭据', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response('reflected-secret', { status: 401 }));
    vi.stubGlobal('fetch', mock);
    await expect(chat(config, [])).rejects.toThrow('鉴权');
    expect(mock).toHaveBeenCalledOnce();
  });
  it('限流最多临时重试两次', async () => {
    vi.useFakeTimers();
    const mock = vi
      .fn()
      .mockResolvedValue(new Response('rate', { status: 429 }));
    vi.stubGlobal('fetch', mock);
    const result = chat(config, []).catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error.message).toContain('限流');
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it('仅 reasoning_content 不当作最终答案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { reasoning_content: '思考' } }],
          }),
        ),
      ),
    );
    await expect(chat(config, [])).rejects.toThrow('答案正文');
  });
  it('主动取消不继续重试', async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    await expect(chat(config, [], controller.signal)).rejects.toThrow('取消');
    expect(mock).not.toHaveBeenCalled();
  });
});

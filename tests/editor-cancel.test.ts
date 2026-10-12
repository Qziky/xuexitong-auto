import { describe, expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
const mock = vi.hoisted(() => ({ state: undefined as any }));
vi.mock('../src/background/store', () => mock);
import { editorBridge } from '../src/background/editor';
describe('UEditor 等待期间的取消保护', () => {
  it('取消后只完成初始化读取，不执行迟到的 MAIN 写入', async () => {
    mock.state = initialState();
    const executeScript = vi.fn(async (_details: any) => [
      { result: { answerEditor1: '' } },
    ]);
    vi.stubGlobal('chrome', { scripting: { executeScript } });
    await expect(
      editorBridge(
        1,
        3,
        { taskKey: '1:2:work:3', fingerprint: 'fp' },
        'write',
        [{ id: 'answerEditor1', value: 'for' }],
      ),
    ).rejects.toThrow(/取消/);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript.mock.calls[0]![0].args[1]).toBe('read');
    vi.unstubAllGlobals();
  });
});

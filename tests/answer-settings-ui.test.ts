import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { initialState } from '../src/domain';
import { AnswerSettingsPanel } from '../src/ui/AnswerSettings';
import { command } from '../src/ui/client';
vi.mock('../src/ui/client', () => ({ command: vi.fn(async () => true) }));

/** Dispatch a real input event while bypassing React's old-value tracker. */
function changeNumber(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
it('保存独立答题并发和批量，清空输入不会被后台刷新覆盖', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    onError = vi.fn(),
    onRefresh = vi.fn(async () => {});
  try {
    await act(async () =>
      root.render(
        createElement(AnswerSettingsPanel, {
          state: initialState(),
          onError,
          onRefresh,
        }),
      ),
    );
    const inputs = host.querySelectorAll('input');
    expect(inputs).toHaveLength(2);
    await act(async () => {
      changeNumber(inputs[0]!, '');
    });
    expect(host.querySelector('button')!.disabled).toBe(true);
    await act(async () => {
      changeNumber(inputs[0]!, '50');
      changeNumber(inputs[1]!, '12');
    });
    await act(async () => {
      host.querySelector('button')!.click();
    });
    expect(command).toHaveBeenCalledWith('save-answer-settings', {
      settings: { concurrency: 50, batchSize: 12 },
    });
    expect(host.textContent).toContain('已保存，从下一次生成答案生效');
    expect(onError).toHaveBeenCalledWith('');
    expect(onRefresh).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

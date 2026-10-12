import type { Binding } from '../messages';
import { state } from './store';
import { assertWriteOperation } from './write-authorization';

export async function editorBridge(
  tabId: number,
  frameId: number,
  binding: Binding,
  action: 'read' | 'write',
  values: { id: string; value?: string }[],
): Promise<Record<string, string>> {
  if (action === 'write') {
    // Wait for editor initialization without performing a write. A cancel during
    // the ready callback must not leave a delayed MAIN-world write behind.
    await editorBridge(
      tabId,
      frameId,
      binding,
      'read',
      values.map(({ id }) => ({ id })),
    );
    if (binding.operationId)
      assertWriteOperation(binding, tabId, frameId, 'fill');
    const item = state.queue.items[state.queue.index];
    const queued =
      state.queue.phase === 'running' &&
      item?.stage === 'filling' &&
      item.tabId === tabId &&
      item.snapshot?.taskKey === binding.taskKey &&
      item.snapshot?.fingerprint === binding.fingerprint;
    const manual = Object.values(state.workflows).some(
      (w) =>
        w.phase === 'running' &&
        w.action === 'fill' &&
        w.stage === 'filling' &&
        w.tabId === tabId &&
        w.frameId === frameId &&
        state.preparations[w.taskId]?.taskKey === binding.taskKey &&
        state.preparations[w.taskId]?.fingerprint === binding.fingerprint,
    );
    if (!queued && !manual) throw new Error('编辑器写入已取消或页面绑定已失效');
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: async (
      key: string,
      mode: string,
      entries: { id: string; value?: string }[],
    ) => {
      const u = new URL(location.href);
      let parent = new URLSearchParams();
      try {
        parent = new URL(document.referrer).searchParams;
      } catch {
        /* No referrer. */
      }
      const course =
        u.searchParams.get('courseid') ??
        u.searchParams.get('courseId') ??
        (
          document.querySelector(
            'input[name="courseid"],input[name="courseId"]',
          ) as HTMLInputElement | null
        )?.value ??
        parent.get('courseid') ??
        parent.get('courseId') ??
        '';
      const clazz =
        u.searchParams.get('clazzId') ??
        u.searchParams.get('clazzid') ??
        u.searchParams.get('classId') ??
        (
          document.querySelector(
            'input[name="clazzid"],input[name="classId"]',
          ) as HTMLInputElement | null
        )?.value ??
        parent.get('clazzId') ??
        parent.get('clazzid') ??
        parent.get('classId') ??
        '';
      const work =
        u.searchParams.get('workId') ??
        u.searchParams.get('workid') ??
        (
          document.querySelector(
            'input[name="workId"],input[name="workid"]',
          ) as HTMLInputElement | null
        )?.value ??
        '';
      const boundCourse =
        course || parent.get('courseid') || parent.get('courseId') || '';
      const boundClazz =
        clazz ||
        parent.get('clazzid') ||
        parent.get('clazzId') ||
        parent.get('classId') ||
        '';
      if (!work || `${boundCourse}:${boundClazz}:work:${work}` !== key)
        throw new Error('编辑器所属任务已变化');
      const ue = (window as any).UE;
      if (!ue?.getEditor || entries.length > 100)
        throw new Error('页面编辑器不可用');
      const result: Record<string, string> = {};
      for (const entry of entries) {
        if (!/^(?:answerEditor|textarea|answer)\d+$/.test(entry.id))
          throw new Error('编辑器 ID 无效');
        const node = document.getElementById(entry.id);
        if (!node || !node.closest('.TiMu, .questionLi'))
          throw new Error('编辑器不属于当前题目');
        const editor = ue.getEditor(entry.id);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('编辑器初始化超时')),
            8000,
          );
          editor.ready(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (mode === 'write') {
          if (typeof entry.value !== 'string' || entry.value.length > 2000)
            throw new Error('填空内容无效');
          const escape = (v: string) =>
            v.replace(
              /[&<>"']/g,
              (c) =>
                ({
                  '&': '&amp;',
                  '<': '&lt;',
                  '>': '&gt;',
                  '"': '&quot;',
                  "'": '&#39;',
                })[c]!,
            );
          editor.setContent(escape(entry.value).replace(/\n/g, '<br>'));
          editor.fireEvent('contentchange');
          editor.sync?.();
        }
        result[entry.id] = String(editor.getContentTxt?.() ?? '').trim();
      }
      return result;
    },
    args: [binding.taskKey, action, values],
  });
  const result = results[0]?.result;
  if (!result) throw new Error('无法读取页面编辑器');
  return result;
}

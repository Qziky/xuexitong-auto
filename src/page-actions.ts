import type { AnswerProposal, PageSnapshot } from './domain';
import type { Binding } from './messages';
import { extractPage } from './page-parser';
import { rpc } from './messages';
import { existingAnswersDigest } from './preparation';
import { editableChoiceElements } from './choice-elements';

export function visible(el: Element | null | undefined): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const s = getComputedStyle(el);
  return (
    s.display !== 'none' &&
    s.visibility !== 'hidden' &&
    s.opacity !== '0' &&
    el.getClientRects().length > 0
  );
}
export async function liveSnapshot(): Promise<PageSnapshot | undefined> {
  const page = extractPage(document, location.href, document.cookie);
  if (!page) return undefined;
  const ids = page.questions.flatMap((q) =>
    q.blanks.filter((b) => b.kind === 'ueditor').map((b) => b.id),
  );
  if (ids.length) {
    const values = await rpc<Record<string, string>>({
      target: 'background',
      kind: 'editor',
      action: 'read',
      binding: { taskKey: page.taskKey, fingerprint: page.fingerprint },
      ids,
    });
    page.questions.forEach((q) => {
      q.blanks.forEach((b) => {
        if (b.kind === 'ueditor') b.value = values[b.id] ?? '';
      });
      if (q.type === 'blank') q.existing = q.blanks.map((b) => b.value);
    });
  }
  return page;
}
export function assertBinding(
  page: PageSnapshot | undefined,
  binding: Binding,
): asserts page is PageSnapshot {
  if (
    !page ||
    !binding.taskKey ||
    page.taskKey !== binding.taskKey ||
    page.fingerprint !== binding.fingerprint
  )
    throw new Error('题目或页面已变化，请重新提取');
  if (page.status === 'submitted' || page.status === 'complete')
    throw new Error('任务已经提交，禁止修改');
  if (page.pageMode === 'preview')
    throw new Error('当前页面仅供预览，禁止填写、保存或提交');
  if (binding.accountId && page.status !== 'pending')
    throw new Error('平台任务状态无法确认，禁止写入');
  if (binding.accountId && page.accountId !== binding.accountId)
    throw new Error('页面登录账号已变化');
  if (
    binding.existingDigest &&
    existingAnswersDigest(page) !== binding.existingDigest
  )
    throw new Error('已有答案已变化，请重新核对');
}
function rootFor(page: PageSnapshot, id: string): Element | undefined {
  return [
    ...document.querySelectorAll(
      page.adapter === 'modern' ? '.questionLi' : '.TiMu',
    ),
  ].find(
    (root) =>
      root.id === `question${id}` ||
      root.querySelector('[qid]')?.getAttribute('qid') === id ||
      root.querySelector(`[name="answertype${id}"]`),
  );
}
export async function authorizeWrite(
  binding: Binding | undefined,
  action: 'fill' | 'draft' | 'submit' | 'confirm',
): Promise<void> {
  if (!binding?.operationId) return;
  await rpc({ target: 'background', kind: 'authorize-write', binding, action });
}
export async function fillPage(
  binding: Binding,
  proposals: AnswerProposal[],
): Promise<PageSnapshot> {
  const page = await liveSnapshot();
  assertBinding(page, binding);
  for (const proposal of proposals) {
    // Page identity is checked between editor writes as well as at entry/exit.
    assertBinding(await liveSnapshot(), {
      ...binding,
      existingDigest: undefined,
    });
    // A snapshot may wait for UEditor initialization. Recheck the operation after
    // that await so a cancelled command cannot resume with a late native click.
    await authorizeWrite(binding, 'fill');
    const q = page.questions.find((q) => q.id === proposal.questionId);
    // The background selects only decoded, confirmed questions. Re-extraction
    // here checks image identity, but cannot reproduce that recognition result.
    const structuralIssues = q?.issues.filter(
      (issue) => issue !== '题目文字识别需检查（图片待识别）',
    );
    if (!q || q.type === 'unsupported' || structuralIssues?.length)
      throw new Error('填写目标无法确认');
    const root = rootFor(page, q.id);
    if (!root) throw new Error('题目节点已变化');
    if (q.type === 'blank') {
      if (!proposal.blanks || proposal.blanks.length !== q.blanks.length)
        throw new Error('填空数量不一致');
      const editorValues: { id: string; value: string }[] = [];
      for (let i = 0; i < q.blanks.length; i++) {
        const b = q.blanks[i]!;
        const value = proposal.blanks[i]!;
        if (!value.trim() && proposal.needsReview) continue;
        if (b.value === value) continue;
        if (b.kind === 'ueditor') {
          editorValues.push({ id: b.id, value });
          continue;
        }
        const input = document.getElementById(b.id);
        if (
          !(
            input instanceof HTMLInputElement ||
            input instanceof HTMLTextAreaElement
          ) ||
          !root.contains(input) ||
          input.disabled ||
          input.readOnly
        )
          throw new Error('填空位置不可编辑');
        const proto =
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (editorValues.length)
        await rpc({
          target: 'background',
          kind: 'editor',
          action: 'write',
          binding,
          values: editorValues,
        });
    } else {
      const ids = proposal.optionIds ?? [];
      if (!ids.length && proposal.needsReview) continue;
      if (
        ids.some((id) => !q.options.some((o) => o.id === id)) ||
        (q.type !== 'multiple' && ids.length !== 1)
      )
        throw new Error('选项答案无效');
      const choices = editableChoiceElements(root);
      if (choices.length !== q.options.length)
        throw new Error('选项节点已变化，请重新提取');
      if (q.type === 'multiple') {
        for (const option of q.options) {
          const want = ids.includes(option.id);
          const selected = q.existing.includes(option.id);
          if (want !== selected) choices[q.options.indexOf(option)]!.click();
        }
      } else if (q.existing[0] !== ids[0]) {
        const i = q.options.findIndex((o) => o.id === ids[0]);
        if (!choices[i]) throw new Error('答案节点不存在');
        choices[i]!.click();
      }
    }
  }
  const after = await liveSnapshot();
  assertBinding(after, { ...binding, existingDigest: undefined });
  return after;
}
export async function pageButton(
  binding: Binding,
  kind: 'draft' | 'submit',
): Promise<{ clicked: boolean }> {
  const page = await liveSnapshot();
  assertBinding(page, binding);
  await authorizeWrite(binding, kind);
  const selector =
    page.adapter === 'modern'
      ? kind === 'draft'
        ? '[onclick*="saveWork"]'
        : '[onclick*="submitValidate"]'
      : kind === 'draft'
        ? '[onclick*="noSubmit"]'
        : '[onclick*="btnBlueSubmit"]';
  const button = [...document.querySelectorAll(selector)].find(visible);
  if (!button)
    throw new Error(
      kind === 'draft' ? '未找到可见的保存草稿按钮' : '未找到可见的提交按钮',
    );
  button.click();
  return { clicked: true };
}
export function confirmVisible(
  taskKey: string,
  binding?: Binding,
): { confirmed: boolean; pending: boolean; message?: string } {
  const own = extractPage(document, location.href, document.cookie);
  if (
    own &&
    (!binding ||
      own.taskKey !== taskKey ||
      own.fingerprint !== binding.fingerprint ||
      (binding.accountId !== undefined &&
        own.accountId !== binding.accountId) ||
      (binding.existingDigest !== undefined &&
        existingAnswersDigest(own) !== binding.existingDigest))
  )
    throw new Error('确认框所属任务已变化');
  // Only known submission dialogs. Never accept unrelated site prompts.
  const legacy = [...document.querySelectorAll('#workpop, #confirmSubWin')].find(visible);
  const modern = [
    ...document.querySelectorAll(
      '.layui-layer, .popDiv, .popWindow, .confirmBox, [role="dialog"]',
    ),
  ].find((n) => visible(n) && /提交/.test(n.textContent ?? ''));
  const dialog = visible(legacy) ? legacy : modern;
  if (!dialog || !visible(dialog)) return { confirmed: false, pending: true };
  if (!/提交/.test(dialog.textContent ?? '') || !taskKey)
    return { confirmed: false, pending: true };
  const button =
    dialog.querySelector('#popok, .layui-layer-btn0, .sure, .confirm') ??
    [...dialog.querySelectorAll('a,button,[role="button"]')].find((n) =>
      /^(?:确定|确认|提交|确认提交)$/.test((n.textContent ?? '').trim()),
    );
  if (!visible(button)) return { confirmed: false, pending: true };
  button.click();
  return { confirmed: true, pending: false };
}

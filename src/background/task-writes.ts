import type { AnswerProposal, PageSnapshot, TaskRecord } from '../domain';
import type { Binding } from '../messages';
import { completeAnswer, readbackMatches, existingProposal } from '../answers';
import { assertTaskCapability } from '../page-workspace';
import { existingAnswersDigest } from '../preparation';
import { serverDraftMatches } from '../draft-verification';
import { state } from './store';
import {
  frameCall,
  discoverFrames,
  offscreen,
  delay,
  type FrameRef,
} from './transport';
import { assertPlatformReady, rethrowPlatformBlock } from './platform';
import { checkFrames } from './scan-control';
import { operationEvent, updateOperation } from './operations';

export async function guardTask(
  ref: Pick<FrameRef, 'tabId' | 'frameId'>,
  task: TaskRecord,
  signal: AbortSignal,
): Promise<void> {
  assertPlatformReady();
  if (signal.aborted) throw new Error('操作已取消');
  if (state.accountId !== task.accountId) throw new Error('登录账号已变化');
  const all = await discoverFrames(ref.tabId);
  if (all.some((f) => f.loginRequired))
    throw new Error('登录已失效，请重新登录');
  checkFrames(all, task.accountId);
}
export async function assertCurrent(
  ref: Pick<FrameRef, 'tabId' | 'frameId'>,
  task: TaskRecord,
  expected: PageSnapshot,
  digest: string,
  revision: number,
  signal: AbortSignal,
  runId?: string,
): Promise<PageSnapshot> {
  await guardTask(ref, task, signal);
  const current = await frameCall<PageSnapshot | undefined>(ref, {
    op: 'extract',
  });
  if (
    !current ||
    current.status !== 'pending' ||
    current.accountId !== task.accountId ||
    current.taskKey !== expected.taskKey ||
    current.fingerprint !== expected.fingerprint ||
    existingAnswersDigest(current) !== digest ||
    revision !== state.providerRevision
  )
    throw new Error('页面、已有答案或设置已变化，旧结果未应用');
  operationEvent(runId, '账号、任务、题目指纹、已有答案及配置核对通过', {
    code: 'binding-verified',
  });
  return current;
}
export function writableAnswers(
  page: PageSnapshot,
  proposals: AnswerProposal[],
): AnswerProposal[] {
  return proposals.filter((a) => {
    const q = page.questions.find((q) => q.id === a.questionId);
    return (
      q &&
      !q.issues.length &&
      q.type !== 'unsupported' &&
      (q.type === 'blank'
        ? a.blanks?.length === q.blanks.length && a.blanks.some((v) => v.trim())
        : a.optionIds?.length &&
          a.optionIds.every((id) => q.options.some((o) => o.id === id)))
    );
  });
}
export async function fillBound(
  ref: Pick<FrameRef, 'tabId' | 'frameId'>,
  task: TaskRecord,
  page: PageSnapshot,
  proposals: AnswerProposal[],
  digest: string,
  revision: number,
  signal: AbortSignal,
  runId?: string,
  allowBestCandidate = false,
): Promise<{ readback: PageSnapshot; verified: boolean; complete: boolean }> {
  assertTaskCapability(task, 'fill');
  proposals = proposals.map((answer) => {
    const question = page.questions.find((q) => q.id === answer.questionId)!;
    if (state.draftPolicy !== 'preserve') return answer;
    if (question.type !== 'blank')
      return question.existing.length ? existingProposal(question) : answer;
    return {
      ...answer,
      blanks: answer.blanks?.map((value, index) =>
        question.blanks[index]?.value.trim()
          ? question.blanks[index]!.value
          : value,
      ),
    };
  });
  await assertCurrent(ref, task, page, digest, revision, signal, runId);
  const binding: Binding = {
    operationId: runId,
    taskKey: page.taskKey,
    fingerprint: page.fingerprint,
    accountId: task.accountId,
    existingDigest: digest,
  };
  const writable = writableAnswers(page, proposals);
  for (const q of page.questions.filter(
    (q) => !writable.some((a) => a.questionId === q.id),
  ))
    operationEvent(
      runId,
      '本题跳过填写：文字未确认、题型不支持或没有有效候选',
      { code: 'fill-skipped', questionNumber: q.number },
      'warn',
    );
  updateOperation(
    runId,
    `填写 ${writable.length}/${page.questions.length} 题答案`,
    { stage: 'filling', done: 0, total: writable.length },
  );
  // Fill per question so each write is observable and cancellation can interrupt between writes.
  let expectedDigest = digest;
  for (const [i, answer] of writable.entries()) {
    await guardTask(ref, task, signal);
    const after = await frameCall<PageSnapshot>(ref, {
      op: 'fill',
      binding: { ...binding, existingDigest: expectedDigest },
      proposals: [answer],
    });
    expectedDigest = existingAnswersDigest(after);
    operationEvent(
      runId,
      '第 ' +
        page.questions.find((q) => q.id === answer.questionId)!.number +
        ' 题已填写' +
        (answer.needsReview
          ? allowBestCandidate
            ? '（按授权填写低置信最高候选）'
            : '（不确定候选，待检查）'
          : ''),
      {
        code:
          answer.needsReview && allowBestCandidate
            ? 'best-candidate-filled'
            : 'answer-filled',
        questionNumber: page.questions.find((q) => q.id === answer.questionId)!
          .number,
        done: i + 1,
        total: writable.length,
      },
    );
    updateOperation(runId, `已填写 ${i + 1}/${writable.length} 题`, {
      done: i + 1,
      total: writable.length,
    });
  }
  await guardTask(ref, task, signal);
  updateOperation(runId, '正在回读核对填写结果', { stage: 'readback' });
  const readback = await frameCall<PageSnapshot | undefined>(ref, {
    op: 'extract',
  });
  if (!readback) throw new Error('无法回读填写结果');
  const verified =
    readback.status === 'pending' &&
    readback.accountId === task.accountId &&
    readback.taskKey === page.taskKey &&
    readback.fingerprint === page.fingerprint &&
    readbackMatches(readback.questions, writable);
  operationEvent(
    runId,
    verified ? '填写回读一致' : '填写回读不一致，禁止提交',
    { code: 'readback' },
    verified ? 'info' : 'warn',
  );
  return {
    readback,
    verified,
    complete:
      verified &&
      page.questions.every((q) =>
        completeAnswer(
          q,
          proposals.find((a) => a.questionId === q.id),
          allowBestCandidate,
        ),
      ),
  };
}
export async function saveBoundDraft(
  ref: Pick<FrameRef, 'tabId' | 'frameId'>,
  task: TaskRecord,
  expected: PageSnapshot,
  signal: AbortSignal,
  runId?: string,
): Promise<{ triggered: boolean; verified: boolean }> {
  await guardTask(ref, task, signal);
  updateOperation(runId, '正在保存平台草稿', { stage: 'saving' });
  await frameCall(ref, {
    op: 'draft',
    binding: {
      operationId: runId,
      taskKey: expected.taskKey,
      fingerprint: expected.fingerprint,
      accountId: task.accountId,
      existingDigest: existingAnswersDigest(expected),
    },
  });
  operationEvent(runId, '保存按钮已触发，尚未确认服务端保存', {
    code: 'draft-triggered',
  });
  return {
    triggered: true,
    verified: await verifySavedDraft(ref, task, expected, signal, runId),
  };
}
export async function verifySavedDraft(
  ref: Pick<FrameRef, 'tabId' | 'frameId'>,
  task: TaskRecord,
  expected: PageSnapshot,
  signal: AbortSignal,
  runId?: string,
): Promise<boolean> {
  updateOperation(runId, '正在读取服务端草稿核验', { stage: 'verifying' });
  let verified = false;
  try {
    const read = await offscreen<{ html: string; url: string }>(
      { op: 'fetch', url: expected.url, fresh: true, purpose: 'result' },
      signal,
      runId,
    );
    const server = await offscreen<PageSnapshot | undefined>(
      { op: 'draft-snapshot', ...read },
      signal,
      runId,
    );
    await guardTask(ref, task, signal);
    verified = serverDraftMatches(expected, server);
  } catch (error) {
    rethrowPlatformBlock(error);
    if (signal.aborted) throw error;
  }
  operationEvent(
    runId,
    verified
      ? '服务端草稿答案一致，已核验保存且未提交'
      : '无法确认服务端草稿，请到平台检查',
    { code: verified ? 'draft-verified' : 'draft-unknown' },
    verified ? 'info' : 'warn',
  );
  return verified;
}
export async function submitBound(
  ref: Pick<FrameRef, 'tabId' | 'frameId'>,
  task: TaskRecord,
  expected: PageSnapshot,
  signal: AbortSignal,
  runId?: string,
): Promise<void> {
  await guardTask(ref, task, signal);
  const binding: Binding = {
    operationId: runId,
    taskKey: expected.taskKey,
    fingerprint: expected.fingerprint,
    accountId: task.accountId,
    existingDigest: existingAnswersDigest(expected),
  };
  updateOperation(runId, '正在触发平台提交', { stage: 'submitting' });
  await frameCall(ref, { op: 'submit', binding });
  const end = Date.now() + 16000;
  while (Date.now() < end) {
    await guardTask(ref, task, signal);
    const refs = await discoverFrames(ref.tabId);
    const current = await frameCall<PageSnapshot | undefined>(ref, {
      op: 'extract',
    }).catch(() => undefined);
    if (
      current?.taskKey === binding.taskKey &&
      current.accountId === task.accountId &&
      (current.status === 'submitted' || current.status === 'complete')
    )
      return;
    if (
      current &&
      (current.taskKey !== binding.taskKey ||
        current.fingerprint !== binding.fingerprint ||
        current.accountId !== task.accountId ||
        existingAnswersDigest(current) !== binding.existingDigest)
    )
      throw new Error('提交确认前页面或已有答案已变化，未确认提交');
    if (
      current?.taskKey === binding.taskKey &&
      current.fingerprint === binding.fingerprint &&
      current.accountId === task.accountId
    ) {
      for (const frame of refs) {
        try {
          const result = await frameCall<{ confirmed: boolean }>(frame, {
            op: 'confirm',
            taskKey: binding.taskKey,
            binding,
          });
          if (result.confirmed) {
            operationEvent(runId, '可见的本任务提交确认框已确认', {
              code: 'submit-confirmed',
            });
            return;
          }
        } catch (error) {
          rethrowPlatformBlock(error);
        }
      }
    }
    await delay(500, signal);
  }
  operationEvent(
    runId,
    '未确认提交弹窗，继续核验结果；不会再次点击提交',
    { code: 'confirm-unknown' },
    'warn',
  );
}

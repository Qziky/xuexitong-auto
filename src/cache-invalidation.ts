import type { AppState, QuestionRecord } from './domain';

export function invalidateCandidates(
  state: AppState,
  affected: (q: QuestionRecord) => boolean,
): void {
  for (const [id, record] of Object.entries(state.preparations)) {
    if (!record.snapshot) {
      delete state.preparations[id];
      continue;
    }
    record.retainedQuestionIds = record.snapshot.questions
      .filter((q) => !affected(q))
      .map((q) => q.id);
    record.decoded =
      record.retainedQuestionIds.length === record.snapshot.questions.length;
    record.proposals = undefined;
    record.providerRevision = state.providerRevision;
    record.recognitionRevision = state.recognitionRevision;
    record.answerRevision = state.answerRevision;
    record.resultRevision = (record.resultRevision ?? 0) + 1;
    record.phase = record.decoded ? 'decoded' : 'cancelled';
    record.note = record.decoded
      ? '设置已更新，可靠文字已保留；请重新生成参考答案'
      : '识别配置已变化，请重新识别受影响的文字';
    const workflow = state.workflows[id];
    if (workflow) {
      workflow.filled = workflow.readbackVerified = false;
      workflow.expectedDigest = undefined;
      for (const stage of [
        'filling',
        'readback',
        'saving',
        'submitting',
        'verifying',
      ] as const)
        delete workflow.steps[stage];
    }
  }
}
export function usesRecognitionEngine(
  q: QuestionRecord,
  engine: string,
): boolean {
  return (
    !!q.recognition &&
    [
      q.recognition.stem,
      ...Object.values(q.recognition.options),
      ...Object.values(q.recognition.images ?? {}),
    ].some((trace) => trace.source === engine)
  );
}

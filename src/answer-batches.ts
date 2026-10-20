import type { AnswerProposal, AnswerSettings, QuestionRecord } from './domain';

/** Run bounded batches, retaining batch order and cancelling siblings on failure. */
export async function solveAnswerBatches(
  questions: QuestionRecord[],
  settings: AnswerSettings,
  signal: AbortSignal,
  execute: (
    batch: QuestionRecord[],
    signal: AbortSignal,
  ) => Promise<AnswerProposal[]>,
  onStart: (
    batch: QuestionRecord[],
    index: number,
    total: number,
    done: number,
  ) => void | Promise<void>,
  onComplete: (
    answers: AnswerProposal[],
    batch: QuestionRecord[],
    done: number,
  ) => void | Promise<void>,
): Promise<{ answers: AnswerProposal[]; error?: unknown }> {
  if (signal.aborted) throw new Error('操作已取消');
  const batches: QuestionRecord[][] = [];
  for (let index = 0; index < questions.length; index += settings.batchSize)
    batches.push(questions.slice(index, index + settings.batchSize));
  const controller = new AbortController();
  const results: AnswerProposal[][] = [];
  let cursor = 0,
    done = 0,
    failure: unknown;
  let reports = Promise.resolve();
  /** Forward user cancellation to both active and queued sibling requests. */
  function cancelBatches() {
    controller.abort();
  }
  signal.addEventListener('abort', cancelBatches, { once: true });
  /** Take one batch at a time, publishing completed counts in a single sequence. */
  async function worker(): Promise<void> {
    while (!controller.signal.aborted && cursor < batches.length) {
      const index = cursor++,
        batch = batches[index]!;
      try {
        await onStart(batch, index, batches.length, done);
        if (controller.signal.aborted) break;
        const answers = await execute(batch, controller.signal);
        if (controller.signal.aborted) break;
        results[index] = answers;
        done += batch.length;
        const completed = done,
          snapshot = results.flat();
        reports = reports.then(async () => {
          if (!controller.signal.aborted)
            await onComplete(snapshot, batch, completed);
        });
        await reports;
      } catch (error) {
        if (failure === undefined) failure = error;
        controller.abort();
      }
    }
  }
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(settings.concurrency, batches.length) },
        worker,
      ),
    );
    if (signal.aborted) throw new Error('操作已取消');
    return { answers: results.flat(), error: failure };
  } finally {
    signal.removeEventListener('abort', cancelBatches);
  }
}

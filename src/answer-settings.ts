import { DEFAULT_ANSWER_SETTINGS, type AnswerSettings } from './domain';

export const MIN_ANSWER_REQUESTS = 1;
export const MAX_ANSWER_REQUESTS = 50;

/** Restore old storage with defaults, retaining valid user-selected limits. */
export function answerSettingsDefaults(
  value?: Partial<AnswerSettings>,
): AnswerSettings {
  return {
    concurrency: Number.isInteger(value?.concurrency)
      ? Math.max(
          MIN_ANSWER_REQUESTS,
          Math.min(MAX_ANSWER_REQUESTS, value!.concurrency!),
        )
      : DEFAULT_ANSWER_SETTINGS.concurrency,
    batchSize: Number.isInteger(value?.batchSize)
      ? Math.max(
          MIN_ANSWER_REQUESTS,
          Math.min(MAX_ANSWER_REQUESTS, value!.batchSize!),
        )
      : DEFAULT_ANSWER_SETTINGS.batchSize,
  };
}

/** Reject invalid incoming settings rather than silently changing saved values. */
export function validateAnswerSettings(value: unknown): AnswerSettings {
  const settings = value as Partial<AnswerSettings> | undefined;
  if (
    !settings ||
    [settings.concurrency, settings.batchSize].some(
      (limit) =>
        !Number.isInteger(limit) ||
        limit! < MIN_ANSWER_REQUESTS ||
        limit! > MAX_ANSWER_REQUESTS,
    )
  )
    throw new Error('答题并发和每批题数须为 1 至 50 的整数');
  return answerSettingsDefaults(settings);
}

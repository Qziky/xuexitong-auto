import type { LearningSettings } from './domain';
export const DEFAULT_LEARNING_SETTINGS: LearningSettings = {
  readingIntervalMs: 250,
  preferredPlaybackRate: 2,
  settingsVersion: 1,
};
export function validateLearningSettings(value: unknown): LearningSettings {
  const ms = (value as Partial<LearningSettings> | undefined)
    ?.readingIntervalMs;
  if (!Number.isInteger(ms) || ms! < 250 || ms! > 5000)
    throw new Error('阅读节奏须为 250 至 5000 毫秒的整数');
  const rate = (value as Partial<LearningSettings>).preferredPlaybackRate ?? 2;
  if (rate !== 1 && rate !== 2)
    throw new Error('播放速度须为正常速度或优先 2 倍速');
  return {
    readingIntervalMs: ms!,
    preferredPlaybackRate: rate,
    settingsVersion: 1,
  };
}
/** Upgrade the previous default exactly once; future explicit 1s settings survive. */
export function upgradeLearningSettings(value: unknown): LearningSettings {
  const old = value as Partial<LearningSettings> | undefined;
  return learningSettingsDefaults(
    old?.settingsVersion === 1
      ? old
      : {
          ...old,
          readingIntervalMs:
            old?.readingIntervalMs === 1000
              ? 250
              : (old?.readingIntervalMs ?? 250),
        },
  );
}
export function learningSettingsDefaults(value: unknown): LearningSettings {
  try {
    return validateLearningSettings(value);
  } catch {
    return { ...DEFAULT_LEARNING_SETTINGS };
  }
}
export function readingIntervalFromSeconds(value: string): number {
  const ms = value.trim() ? Number(value) * 1000 : NaN;
  const rounded = Math.round(ms);
  return Math.abs(ms - rounded) <= Number.EPSILON * Math.abs(ms) * 2
    ? rounded
    : ms;
}

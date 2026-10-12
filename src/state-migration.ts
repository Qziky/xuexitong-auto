import { initialState, type AppState, type TaskRecord } from './domain';
import { recoverQueue } from './queue';
import { recognitionDefaults } from './recognition-settings';
import { selectedLearningTypes } from './learning-policy';
import { upgradeLearningSettings } from './learning-settings';

export function migrateState(saved: unknown): AppState {
  const initial = initialState();
  if (!saved || typeof saved !== 'object') return initial;
  const old = saved as Omit<AppState, 'schema'> & {
    schema: number;
    detailCache?: unknown;
  };
  if (![1, 2].includes(old.schema)) return initial;
  const { detailCache: _legacyCache, preparations: _session, ...durable } = old;
  const result: AppState = {
    ...initial,
    ...durable,
    schema: 2,
    recognition: recognitionDefaults(old.recognition),
    learningSettings: upgradeLearningSettings(old.learningSettings),
    visionProvider: { ...initial.visionProvider, ...old.visionProvider },
    homeworkCache: old.schema === 2 ? (old.homeworkCache ?? {}) : {},
    preparations: {},
    workspaces: {},
    currentPage: undefined,
    recognitionRevision: old.recognitionRevision ?? 0,
    answerRevision: old.answerRevision ?? 0,
    preferences: { ...initial.preferences, ...old.preferences },
    learning: old.learning
      ? {
          ...initial.learning,
          ...old.learning,
          items: old.learning.items.map((item) => ({
            ...item,
            readingSettings: item.readingSettings
              ? upgradeLearningSettings(item.readingSettings)
              : undefined,
          })),
          selectedTypes: selectedLearningTypes(old.learning),
          foregroundFallback: old.learning.foregroundFallback ?? true,
          lease: undefined,
          documentId: undefined,
          frameId: undefined,
          cursor: old.learning.cursor
            ? {
                ...old.learning.cursor,
                nextChapterId:
                  old.learning.cursor.nextChapterId ??
                  old.learning.cursor.chapters?.[old.learning.cursor.chapter]
                    ?.id,
                chapters: undefined,
              }
            : undefined,
          resumeChild: false,
          phase: ['running', 'paused'].includes(old.learning.phase)
            ? 'paused'
            : old.learning.phase,
          note:
            old.learning.phase === 'running'
              ? '上次学习已中断，请核验后继续'
              : old.learning.note,
        }
      : initial.learning,
    operations: old.operations ?? {},
    workflows: old.workflows ?? {},
    currentTaskId: undefined,
    queue: old.queue
      ? recoverQueue({ ...old.queue, goal: old.queue.goal ?? 'submit' })
      : initial.queue,
  };
  if (old.schema === 1) {
    const history = new Set(result.queue.items.map((item) => item.taskId));
    result.tasks = (old.tasks ?? [])
      .filter((task) => task.type === 'homework' || history.has(task.id))
      .map((task): TaskRecord => ({
        ...task,
        discovery: task.type === 'homework' ? 'list' : 'history',
      }));
    result.courses = (old.courses ?? []).map((course) => ({
      ...course,
      warnings: [],
    }));
    result.scan = {
      ...initial.scan,
      note: '已升级；将重新获取课程进度和普通作业列表',
    };
  }
  return result;
}

import { describe, expect, it } from 'vitest';
import { initialState, type TaskRecord } from '../src/domain';
import { migrateState } from '../src/state-migration';
import { recognitionDefaults } from '../src/recognition-settings';
import { createQueue } from '../src/queue';
describe('schema 2 升级', () => {
  it('旧设置采用 OCR→多模态、开启校验、共用服务，部分字段补默认并保持 schema 2', () => {
    const {
      recognition: _recognition,
      visionProvider: _vision,
      ...old
    } = initialState();
    const result = migrateState(old);
    expect(result.recognition).toEqual({
      strategy: 'ocr-first',
      imageStrategy: 'vision-first',
      validateOcr: true,
      visionService: 'shared',
      visionConcurrency: 5,
    });
    expect(result.schema).toBe(2);
    expect(result.visionProvider.hasKey).toBe(false);
    expect(
      migrateState({
        ...old,
        recognition: { strategy: 'vision-only', validateOcr: false },
      }).recognition,
    ).toEqual({
      strategy: 'vision-only',
      imageStrategy: 'vision-first',
      validateOcr: false,
      visionService: 'shared',
      visionConcurrency: 5,
    });
    expect(
      recognitionDefaults({ visionConcurrency: 1 }).visionConcurrency,
    ).toBe(1);
    expect(
      recognitionDefaults({ visionConcurrency: 128 }).visionConcurrency,
    ).toBe(128);
    expect(
      recognitionDefaults({ visionConcurrency: 129 }).visionConcurrency,
    ).toBe(128);
    expect(
      recognitionDefaults({ visionConcurrency: 0 }).visionConcurrency,
    ).toBe(1);
    expect(
      recognitionDefaults({ visionConcurrency: 1.5 }).visionConcurrency,
    ).toBe(5);
  });
  it('保留作业、执行历史和去重记录，清除章节遍历及旧测验待办', () => {
    const state = initialState();
    const task = {
      id: 'work',
      accountId: 'cx:1',
      courseId: 'c1',
      title: '作业',
      status: 'pending',
      type: 'homework',
    } as TaskRecord;
    const old = {
      ...state,
      schema: 1,
      accountId: 'cx:1',
      detailCache: { directory: { chapters: ['old'] } },
      tasks: [
        task,
        { ...task, id: 'quiz', type: 'quiz' },
        { ...task, id: 'history', type: 'quiz' },
        { ...task, id: 'video', type: 'video' },
      ],
      reminders: { old: 1 },
      queue: {
        ...state.queue,
        phase: 'running',
        items: [
          { taskId: 'history', stage: 'submitting', submitAttempted: true },
        ],
      },
    };
    const migrated = migrateState(old);
    expect(migrated.schema).toBe(2);
    expect(migrated).not.toHaveProperty('detailCache');
    expect(migrated.homeworkCache).toEqual({});
    expect(migrated.tasks.map((t) => t.id)).toEqual(['work', 'history']);
    expect(migrated.reminders.old).toBe(1);
    expect(migrated.queue.phase).toBe('paused');
    expect(migrated.queue.items[0]!.submitAttempted).toBe(true);
    expect(() => createQueue([migrated.tasks[1]!], 'cx:1', 'preserve')).toThrow(
      /请选择/,
    );
  });
  it('候选记录不从本地持久状态恢复，未知版本使用初始状态', () => {
    const state = initialState();
    expect(
      migrateState({
        ...state,
        preparations: { stale: {} },
        currentTaskId: 'stale',
      }).preparations,
    ).toEqual({});
    expect(
      migrateState({ schema: 999, accountId: 'old' }).accountId,
    ).toBeUndefined();
  });
});

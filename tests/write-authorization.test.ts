import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initialState, type OperationProgress } from '../src/domain';
const mock = vi.hoisted(() => ({ state: undefined as any }));
vi.mock('../src/background/store', () => mock);
import { assertWriteOperation } from '../src/background/write-authorization';
const binding = {
  operationId: 'run',
  taskKey: '100:200:work:9',
  fingerprint: 'fp',
  accountId: 'cx:1',
};
beforeEach(() => {
  const s = (mock.state = initialState());
  s.accountId = 'cx:1';
  s.tasks = [
    {
      id: 'task',
      type: 'homework',
      status: 'pending',
      accountId: 'cx:1',
    } as any,
  ];
  s.operations.run = {
    id: 'run',
    kind: 'manual',
    accountId: s.accountId,
    taskId: 'task',
    phase: 'running',
    stage: 'filling',
  } as OperationProgress;
  s.workflows.task = {
    taskId: 'task',
    runId: 'run',
    phase: 'running',
    stage: 'filling',
    tabId: 1,
    frameId: 3,
    steps: {},
  };
  s.preparations.task = {
    ...binding,
    taskId: 'task',
    courseId: '100:200',
    tabId: 1,
    frameId: 3,
    existingDigest: 'digest',
    policy: 'preserve',
    phase: 'filled',
    at: Date.now(),
    providerRevision: s.providerRevision,
  };
});
describe('每次页面写入的操作授权', () => {
  it('有效写入允许，取消、换号、配置变化和其他 iframe 拒绝', () => {
    expect(() => assertWriteOperation(binding, 1, 3, 'fill')).not.toThrow();
    expect(() => assertWriteOperation(binding, 1, 4, 'fill')).toThrow('绑定');
    mock.state.operations.run.phase = 'cancelled';
    expect(() => assertWriteOperation(binding, 1, 3, 'fill')).toThrow('取消');
    mock.state.operations.run.phase = 'running';
    mock.state.providerRevision++;
    expect(() => assertWriteOperation(binding, 1, 3, 'fill')).toThrow('配置');
    mock.state.accountId = 'cx:2';
    expect(() => assertWriteOperation(binding, 1, 3, 'fill')).toThrow();
  });
  it('只有提交阶段可确认同标签父级弹窗，保存阶段不得提交', () => {
    mock.state.operations.run.stage = 'saving';
    expect(() => assertWriteOperation(binding, 1, 3, 'submit')).toThrow('阶段');
    mock.state.operations.run.stage = 'submitting';
    expect(() => assertWriteOperation(binding, 1, 0, 'confirm')).not.toThrow();
    expect(() => assertWriteOperation(binding, 2, 0, 'confirm')).toThrow(
      '绑定',
    );
  });
  it('队列停止后，即使页面命令仍在等待也禁止写入', () => {
    const s = mock.state;
    s.operations.run.kind = 'queue';
    s.queue = {
      ...s.queue,
      phase: 'running',
      runId: 'run',
      items: [
        {
          taskId: 'task',
          snapshot: { taskKey: binding.taskKey, fingerprint: 'fp' },
        },
      ],
      index: 0,
    };
    expect(() => assertWriteOperation(binding, 1, 3, 'fill')).not.toThrow();
    s.queue.phase = 'paused';
    expect(() => assertWriteOperation(binding, 1, 3, 'fill')).toThrow('停止');
  });
});

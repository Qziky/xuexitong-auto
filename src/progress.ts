import type { WorkflowStage } from './domain';

/** Only structured counters and diagnostic metadata, never model payloads. */
export interface ProgressDetail {
  code?: string;
  stage?: WorkflowStage;
  questionNumber?: number;
  questionId?: string;
  part?: string;
  engine?: 'web' | 'ocr' | 'vision' | 'manual';
  done?: number;
  total?: number;
  success?: number;
  review?: number;
  queued?: number;
  active?: number;
  globalActive?: number;
  globalQueued?: number;
  globalLimit?: number;
  confidence?: number;
  attempt?: number;
  durationMs?: number;
  requestStartedAt?: number;
  timeoutSec?: number;
  platformWaitUntil?: number;
  readSource?: 'page' | 'cache' | 'network' | 'shared';
  platformRequests?: number;
  waiting?: 'model' | 'model-lane' | 'vision-lane' | 'platform' | 'page';
}
export type ProgressSink = (note: string, detail?: ProgressDetail) => void;
export const STAGE_LABEL: Record<WorkflowStage, string> = {
  checking: '检查任务',
  extracting: '读取题目',
  restoring: '识别文字',
  reviewing: '文字复核',
  solving: '生成参考',
  filling: '填写答案',
  readback: '回读核对',
  saving: '保存草稿',
  submitting: '提交答案',
  verifying: '核验结果',
};
export function connectionHealth(
  lastHeartbeat: number,
  now: number,
): 'online' | 'delayed' | 'lost' {
  const age = now - lastHeartbeat;
  return age >= 60000 ? 'lost' : age >= 30000 ? 'delayed' : 'online';
}

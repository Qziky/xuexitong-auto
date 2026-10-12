import type {
  DraftPolicy,
  PageSnapshot,
  TaskPreparation,
  TaskRecord,
} from './domain';
import { TEXT_PROCESSING_VERSION } from './domain';
import { hashText } from './security';
export function existingAnswersDigest(page: PageSnapshot): string {
  return hashText(
    JSON.stringify(
      page.questions.map((q) => [
        q.id,
        q.existing,
        q.blanks.map((b) => [b.id, b.value]),
      ]),
    ),
  );
}
export function preparationMatches(
  record: TaskPreparation | undefined,
  page: PageSnapshot,
  task: TaskRecord,
  policy: DraftPolicy,
  revision: number,
): record is TaskPreparation {
  return Boolean(
    record &&
    record.workflowVersion === TEXT_PROCESSING_VERSION &&
    ['ready', 'review', 'filled'].includes(record.phase) &&
    record.snapshot &&
    record.proposals &&
    record.accountId === task.accountId &&
    page.accountId === task.accountId &&
    record.courseId === task.courseId &&
    record.taskId === task.id &&
    record.taskKey === page.taskKey &&
    record.fingerprint === page.fingerprint &&
    record.existingDigest === existingAnswersDigest(page) &&
    record.policy === policy &&
    record.providerRevision === revision,
  );
}

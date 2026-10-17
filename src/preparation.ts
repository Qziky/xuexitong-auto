import type {
  DraftPolicy,
  PageSnapshot,
  TaskPreparation,
  TaskRecord,
  QuestionRecord,
} from './domain';
import { TEXT_PROCESSING_VERSION } from './domain';
import { hashText } from './security';
import { completeAnswer } from './answers';
import { answerImages, requiresTextRecognition } from './image-content';

/** A finished job can still contain failed or incomplete recognition results. */
export function reusableQuestionText(question: QuestionRecord): boolean {
  return (
    !question.issues.length &&
    question.type !== 'unsupported' &&
    (!requiresTextRecognition(question) ||
      !!question.recognition?.stem.source) &&
    question.options.every(
      (option) =>
        !requiresTextRecognition(question, option.id) ||
        !!question.recognition?.options[option.id]?.source,
    ) &&
    answerImages(question).every((image) => !!image.material)
  );
}
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
    record.snapshot.questions.every(
      (question) =>
        reusableQuestionText(question) &&
        completeAnswer(
          question,
          record.proposals!.find(
            (proposal) => proposal.questionId === question.id,
          ),
          true,
        ),
    ) &&
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

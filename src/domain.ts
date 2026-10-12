export const TEXT_PROCESSING_VERSION = 6;
export const PAGE_TEXT_PROCESSING_VERSION = 11;
export type TaskType = 'video' | 'quiz' | 'homework';
export type TaskStatus =
  'pending' | 'submitted' | 'complete' | 'unknown' | 'review' | 'expired';
export type QuestionType =
  'single' | 'multiple' | 'boolean' | 'blank' | 'unsupported';
export type DraftPolicy = 'preserve' | 'overwrite';
export type QueuePhase = 'idle' | 'running' | 'paused' | 'stopped' | 'done';
export type ItemStage =
  | 'waiting'
  | 'checking'
  | 'extracting'
  | 'restoring'
  | 'reviewing'
  | 'solving'
  | 'filling'
  | 'readback'
  | 'saving'
  | 'submitting'
  | 'verifying'
  | 'submitted'
  | 'draft-saved'
  | 'review'
  | 'failed'
  | 'skipped';

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  auth: 'bearer' | 'api-key';
  timeoutSec: number;
  extraBody: Record<string, unknown>;
}
export type PublicProvider = Omit<ProviderConfig, 'apiKey'> & {
  hasKey: boolean;
};
export interface RecognitionSettings {
  strategy: 'ocr-only' | 'vision-only' | 'ocr-first' | 'vision-first';
  imageStrategy?: RecognitionSettings['strategy'] | 'manual';
  validateOcr: boolean;
  visionService: 'shared' | 'independent';
  visionConcurrency: number;
}
export const DEFAULT_RECOGNITION: RecognitionSettings = {
  strategy: 'ocr-first',
  imageStrategy: 'vision-first',
  validateOcr: true,
  visionService: 'shared',
  visionConcurrency: 5,
};
export interface RecognitionAttempt {
  engine: 'web' | 'ocr' | 'vision' | 'manual';
  success: boolean;
  text?: string;
  readings?: { text: string; confidence: number }[];
  reason?: string;
  contentKind?: 'text' | 'formula' | 'unsupported';
}
export interface RecognitionTrace {
  source?: RecognitionAttempt['engine'];
  attempts: RecognitionAttempt[];
}
export interface ScanSource {
  url: string;
  at: number;
  label: string;
}
export interface CourseRecord {
  id: string;
  accountId: string;
  title: string;
  url: string;
  courseId: string;
  classId: string;
  cpi: string;
  taskPoints?: { completed: number; total: number };
  homeworkCounts?: { completed: number; total: number };
  state: 'active' | 'ended' | 'withdrawn' | 'unknown';
  source: ScanSource;
  warnings: string[];
}
export interface HomeworkListCache {
  accountId: string;
  courseId: string;
  entryUrls: string[];
  at?: number;
  lastAttemptAt?: number;
  complete: boolean;
  taskIds: string[];
  note?: string;
}
export interface TaskRecord {
  id: string;
  accountId: string;
  courseId: string;
  title: string;
  type: TaskType;
  status: TaskStatus;
  url: string;
  platformId: string;
  questionCount?: number;
  chapterId?: string;
  jobId?: string;
  deadline?: number;
  deadlineEstimated?: boolean;
  grade?: string;
  source: ScanSource;
  note?: string;
  discovery?: 'list' | 'opened' | 'history';
  listed?: boolean;
  pageMode?: 'answer' | 'preview';
  analysisOnly?: boolean;
  autoSubmitBestCandidate?: boolean;
}
export type AnalysisIntent = 'reference' | 'execution';
export interface PageCapabilities {
  analyze: boolean;
  fill: boolean;
  save: boolean;
  submit: boolean;
}
export interface PageContext {
  kind: 'home' | 'course' | 'questions' | 'unsupported';
  tabId: number;
  url: string;
  courseId?: string;
  workspaceId?: string;
}
export interface PageWorkspace {
  id: string;
  task: TaskRecord;
  tabId: number;
  frameId: number;
  taskKey: string;
  bindingRevision?: string;
  capabilities: PageCapabilities;
  at: number;
}
export type LearningTaskType =
  'video' | 'audio' | 'document' | 'image' | 'quiz' | 'unknown';
export interface LearningCardRef {
  id: string;
  title: string;
  url: string;
}
export interface LearningSettings {
  readingIntervalMs: number;
  preferredPlaybackRate?: 1 | 2;
  settingsVersion?: 1;
}
export type CompletionState =
  'confirmed' | 'incomplete' | 'unknown' | 'conflict';
export interface CompletionEvidence {
  at: number;
  source: 'configuration' | 'card-marker' | 'catalog';
  state?: CompletionState;
  fresh?: boolean;
}
export interface LearningItem {
  id: string;
  courseId: string;
  chapterId: string;
  title: string;
  url: string;
  type: LearningTaskType;
  chapterTitle?: string;
  card?: LearningCardRef;
  completion?: { ratio?: number; seconds?: number; pages?: number };
  completionEvidence?: CompletionEvidence;
  completionState?: CompletionState;
  completionVerificationAttempted?: boolean;
  taskRetryAttempted?: boolean;
  discoveryRetryAttempted?: boolean;
  discoveryRetryCount?: number;
  readerMode?: 'pages' | 'pagination' | 'pdfjs' | 'scroll';
  scrollPosition?: number;
  scrollExtent?: number;
  readingSettings?: LearningSettings;
  settingsSnapshot?: LearningSettings;
  actualPlaybackRate?: number;
  speedStatus?: 'applied' | 'unsupported' | 'overridden';
  completionEventKey?: string;
  pendingCompletionEvidence?: boolean;
  completionFromMarker?: boolean;
  resourceStartedAt?: number;
  localReadingFinished?: boolean;
  currentPage?: number;
  totalPages?: number;
  attempts?: number;
  recovering?: boolean;
  errorCode?: string;
  embeddedTaskId?: string;
  popupDetected?: boolean;
  mediaEnded?: boolean;
  thresholdChecked?: boolean;
  completionRequested?: boolean;
  jobId?: string;
  objectId?: string;
  task?: TaskRecord;
  phase:
    | 'waiting'
    | 'preparing'
    | 'playing'
    | 'reading'
    | 'verifying'
    | 'executing'
    | 'done'
    | 'draft'
    | 'review'
    | 'failed';
  note?: string;
  position?: number;
  duration?: number;
  platformComplete?: boolean;
}
export interface LearningQueue {
  lastAdvancedAt?: number;
  id: string;
  phase: QueuePhase;
  accountId: string;
  courseIds: string[];
  range: 'video' | 'quiz' | 'both';
  selectedTypes?: Exclude<LearningTaskType, 'unknown'>[];
  cursor?: {
    course: number;
    chapters?: import('./learning-parser').ChapterEntry[];
    chapter: number;
    nextChapterId?: string;
    nextCardId?: string;
    cardIds?: string[];
  };
  foregroundFallback?: boolean;
  lease?: string;
  resumeChild?: boolean;
  goal: 'submit' | 'draft';
  policy: DraftPolicy;
  items: LearningItem[];
  index: number;
  discovered: boolean;
  startedAt: number;
  runId?: string;
  tabId?: number;
  frameId?: number;
  documentId?: string;
  note?: string;
  lastHeartbeatAt?: number;
}
export interface QuestionImage {
  id: string;
  part: 'stem' | 'option';
  optionId?: string;
  placeholder: string;
  src?: string;
  resourceKey: string;
  width?: number;
  height?: number;
}
export interface TextPart {
  text: string;
  obfuscated?: boolean;
}
export interface OptionRecord {
  id: string;
  key: string;
  label: string;
  text: string;
  obfuscated?: boolean;
}
export interface BlankRecord {
  id: string;
  kind: 'input' | 'textarea' | 'ueditor';
  value: string;
}
export interface QuestionRecord {
  id: string;
  number: number;
  type: QuestionType;
  stem: string;
  obfuscated?: boolean;
  options: OptionRecord[];
  blanks: BlankRecord[];
  existing: string[];
  required: boolean;
  publishedAnswer?: AnswerProposal;
  issues: string[];
  images?: QuestionImage[];
  textRevision?: number;
  recognition?: {
    stem: RecognitionTrace;
    options: Record<string, RecognitionTrace>;
    images?: Record<string, RecognitionTrace>;
  };
}
export interface PageSnapshot {
  adapter: 'legacy' | 'modern';
  taskKey: string;
  fingerprint: string;
  url: string;
  title: string;
  status: TaskStatus;
  grade?: string;
  deadline?: number;
  questions: QuestionRecord[];
  fontCss?: string;
  accountId?: string;
  pageMode?: 'answer' | 'preview';
}
export interface AnswerProposal {
  questionId: string;
  optionIds?: string[];
  blanks?: string[];
  explanation: string;
  needsReview: boolean;
  source?: 'model' | 'own' | 'platform';
}
export interface QueueItem {
  taskId: string;
  stage: ItemStage;
  note?: string;
  grade?: string;
  startedAt?: number;
  finishedAt?: number;
  snapshot?: PageSnapshot;
  proposals?: AnswerProposal[];
  submitAttempted?: boolean;
  tabId?: number;
  ownedTab?: boolean;
  runId?: string;
  draftAttempted?: boolean;
  draftVerified?: boolean;
  draftSnapshot?: PageSnapshot;
}
export interface TaskPreparation {
  retainedQuestionIds?: string[];
  taskId: string;
  accountId: string;
  courseId: string;
  tabId: number;
  frameId: number;
  taskKey: string;
  fingerprint: string;
  existingDigest: string;
  providerRevision: number;
  recognitionRevision?: number;
  answerRevision?: number;
  intent?: AnalysisIntent;
  policy: DraftPolicy;
  phase:
    | 'extracting'
    | 'restoring'
    | 'decoded'
    | 'solving'
    | 'ready'
    | 'review'
    | 'filled'
    | 'error'
    | 'cancelled';
  workflowVersion?: number;
  resultRevision?: number;
  decoded?: boolean;
  at: number;
  note?: string;
  snapshot?: PageSnapshot;
  proposals?: AnswerProposal[];
}
export interface ConfirmedQuestionText {
  stem?: string;
  options?: Record<string, string>;
}
export interface ExecutionQueue {
  id: string;
  phase: QueuePhase;
  accountId: string;
  policy: DraftPolicy;
  items: QueueItem[];
  index: number;
  startedAt: number;
  note?: string;
  goal?: 'submit' | 'draft';
  runId?: string;
  /** Learning queue that owns this chapter-task execution, when nested. */
  learningId?: string;
}
export type WorkflowStage =
  | 'checking'
  | 'extracting'
  | 'restoring'
  | 'reviewing'
  | 'solving'
  | 'filling'
  | 'readback'
  | 'saving'
  | 'submitting'
  | 'verifying';
export type OperationPhase =
  | 'running'
  | 'waiting-user'
  | 'done'
  | 'review'
  | 'error'
  | 'cancelled'
  | 'paused';
export type TaskAction =
  | 'decode'
  | 'solve'
  | 'decode-question'
  | 'solve-question'
  | 'fill'
  | 'draft'
  | 'submit';
export interface OperationProgress {
  id: string;
  kind: 'manual' | 'queue' | 'learning' | 'scan' | 'test' | 'legacy';
  title: string;
  taskId?: string;
  accountId?: string;
  goal?: 'submit' | 'draft';
  phase: OperationPhase;
  stage: WorkflowStage;
  startedAt: number;
  stageStartedAt: number;
  updatedAt: number;
  lastHeartbeatAt: number;
  lastProgressAt: number;
  finishedAt?: number;
  note: string;
  done?: number;
  total?: number;
  success?: number;
  review?: number;
  queued?: number;
  active?: number;
  globalActive?: number;
  globalQueued?: number;
  globalLimit?: number;
  questionNumber?: number;
  questionId?: string;
  part?: string;
  engine?: 'web' | 'ocr' | 'vision' | 'manual';
  requestStartedAt?: number;
  timeoutSec?: number;
  attempt?: number;
  waiting?: 'model' | 'model-lane' | 'vision-lane' | 'platform' | 'page';
  platformWaitUntil?: number;
  readSource?: 'page' | 'cache' | 'network' | 'shared';
  platformRequests?: number;
  seq: number;
}
export interface WorkflowStep {
  status:
    'pending' | 'running' | 'waiting-user' | 'done' | 'review' | 'interrupted';
  note?: string;
  startedAt?: number;
  finishedAt?: number;
}
export interface TaskWorkflow {
  taskId: string;
  runId: string;
  stage: WorkflowStage;
  phase: OperationPhase;
  action?: TaskAction;
  questionId?: string;
  resultRevision?: number;
  steps: Partial<Record<WorkflowStage, WorkflowStep>>;
  filled?: boolean;
  readbackVerified?: boolean;
  submitAttempted?: boolean;
  draftAttempted?: boolean;
  draftVerified?: boolean;
  expectedDigest?: string;
  tabId?: number;
  frameId?: number;
  note?: string;
}
export interface LogEvent {
  id: string;
  runId: string;
  at: number;
  seq: number;
  level: 'info' | 'warn' | 'error';
  stage: string;
  taskId?: string;
  questionNumber?: number;
  questionId?: string;
  part?: string;
  engine?: 'web' | 'ocr' | 'vision' | 'manual';
  code: string;
  message: string;
  confidence?: number;
  attempt?: number;
  durationMs?: number;
  done?: number;
  total?: number;
  readSource?: OperationProgress['readSource'];
}
export interface EventRecord {
  at: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}
export interface ScanProgress {
  scope?: 'progress' | 'homework' | 'overview';
  courseId?: string;
  phase: 'idle' | 'running' | 'done' | 'cancelled' | 'error' | 'blocked';
  completed: number;
  total: number;
  note: string;
  at: number;
}
export interface PlatformBlock {
  kind: 'captcha' | 'rate-limit';
  at: number;
  message: string;
  url?: string;
  tabId?: number;
  retryAfter?: number;
}
export interface AppState {
  schema: 2;
  accountId?: string;
  courses: CourseRecord[];
  tasks: TaskRecord[];
  queue: ExecutionQueue;
  scan: ScanProgress;
  progressRefreshedAt: number;
  homeworkCache: Record<string, HomeworkListCache>;
  preparations: Record<string, TaskPreparation>;
  workspaces: Record<string, PageWorkspace>;
  currentPage?: PageContext;
  learning: LearningQueue;
  learningSettings: LearningSettings;
  currentTaskId?: string;
  draftPolicy: DraftPolicy;
  providerRevision: number;
  recognitionRevision: number;
  answerRevision: number;
  revision?: number;
  platformBlock?: PlatformBlock;
  provider: PublicProvider;
  recognition: RecognitionSettings;
  visionProvider: PublicProvider;
  events: EventRecord[];
  operations: Record<string, OperationProgress>;
  workflows: Record<string, TaskWorkflow>;
  logStorageError?: string;
  reminders: Record<string, number>;
  preferences: {
    autoScan: boolean;
    notifications: boolean;
    developerMode?: boolean;
  };
}
export const DEFAULT_PROVIDER: ProviderConfig = {
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.6-pro',
  apiKey: '',
  auth: 'bearer',
  timeoutSec: 180,
  extraBody: {},
};
export function publicProvider(p: ProviderConfig): PublicProvider {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: Boolean(apiKey) };
}
export function initialState(): AppState {
  return {
    schema: 2,
    courses: [],
    tasks: [],
    queue: {
      id: '',
      phase: 'idle',
      accountId: '',
      policy: 'preserve',
      items: [],
      index: 0,
      startedAt: 0,
    },
    scan: {
      phase: 'idle',
      completed: 0,
      total: 0,
      note: '登录学习通后自动识别课程',
      at: 0,
    },
    progressRefreshedAt: 0,
    homeworkCache: {},
    preparations: {},
    workspaces: {},
    learningSettings: {
      readingIntervalMs: 250,
      preferredPlaybackRate: 2,
      settingsVersion: 1,
    },
    learning: {
      id: '',
      phase: 'idle',
      accountId: '',
      courseIds: [],
      range: 'both',
      goal: 'submit',
      policy: 'preserve',
      items: [],
      index: 0,
      discovered: false,
      startedAt: 0,
    },
    draftPolicy: 'preserve',
    providerRevision: 0,
    recognitionRevision: 0,
    answerRevision: 0,
    provider: publicProvider(DEFAULT_PROVIDER),
    recognition: { ...DEFAULT_RECOGNITION },
    visionProvider: publicProvider(DEFAULT_PROVIDER),
    events: [],
    operations: {},
    workflows: {},
    reminders: {},
    preferences: { autoScan: true, notifications: true, developerMode: false },
  };
}

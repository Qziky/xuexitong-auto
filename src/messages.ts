import type {
  AnswerProposal,
  PageSnapshot,
  ProviderConfig,
  CourseRecord,
  RecognitionSettings,
} from './domain';
export type FrameCommand =
  | { op: 'learning-menu' }
  | { op: 'learning-card-menu' }
  | { op: 'learning-card-open'; actionId: string; fingerprint: string }
  | {
      op: 'reader-start';
      binding: import('./video-player').VideoBinding;
      completion?: import('./domain').LearningItem['completion'];
      settings?: import('./domain').LearningSettings;
      deferred?: boolean;
    }
  | { op: 'reader-pause' }
  | { op: 'learning-open'; actionId: string; fingerprint: string }
  | { op: 'video-describe' }
  | {
      op: 'video-play';
      settings?: import('./domain').LearningSettings;
      requireProgress?: boolean;
      binding: import('./video-player').VideoBinding;
      deferred?: boolean;
    }
  | { op: 'video-pause'; onlyUnbound?: boolean }
  | {
      op: 'video-recover';
      settings?: import('./domain').LearningSettings;
      binding: import('./video-player').VideoBinding;
      deferred?: boolean;
    }
  | { op: 'describe' }
  | { op: 'html' }
  | { op: 'catalog-menu' }
  | { op: 'catalog-open'; id: string; fingerprint: string }
  | { op: 'extract' }
  | {
      op: 'image-resource';
      binding: Binding;
      imageId: string;
      resourceKey: string;
    }
  | { op: 'fill'; binding: Binding; proposals: AnswerProposal[] }
  | { op: 'draft'; binding: Binding }
  | { op: 'submit'; binding: Binding }
  | { op: 'confirm'; binding?: Binding; taskKey: string }
  | { op: 'result' };
export interface Binding {
  operationId?: string;
  taskKey: string;
  fingerprint: string;
  accountId?: string;
  existingDigest?: string;
}
export interface FrameInfo {
  learningCardIdentity?: {
    chapterId: string;
    cardNumber: string;
    ready: boolean;
  };
  learningIdentity?: import('./learning-frame-identity').LearningIdentity;
  media?: import('./video-player').VideoDescription[];
  reader?: import('./learning-adapters').ReaderDescription;
  learningTargets?: { src: string; objectId?: string; jobId?: string }[];
  hasLearningMenu?: boolean;
  hasObfuscatedText?: boolean;
  video?: import('./video-player').VideoDescription;
  url: string;
  top: boolean;
  accountId?: string;
  taskKey?: string;
  adapter?: string;
  loginRequired: boolean;
  verificationRequired?: boolean;
  taskKind?: 'quiz' | 'homework' | 'exam';
  revision?: string;
  taskSummary?: Pick<
    PageSnapshot,
    'title' | 'status' | 'grade' | 'deadline' | 'pageMode'
  > & {
    questionCount: number;
  };
}
export type OffscreenJob =
  | {
      op: 'learning-cards';
      fresh?: boolean;
      knownReadingTask?: { jobId: string; objectId?: string };
      html: string;
      url: string;
      course: CourseRecord;
      chapterId: string;
    }
  | { op: 'warm-ocr' }
  | {
      op: 'fetch';
      url: string;
      scope?: string;
      fresh?: boolean;
      purpose?:
        'catalog' | 'navigation' | 'homework-list' | 'result' | 'learning';
    }
  | {
      op: 'parse';
      html: string;
      url: string;
      accountId: string;
      course?: CourseRecord;
    }
  | {
      op: 'restore';
      page: PageSnapshot;
      recognition: RecognitionSettings;
      visionProvider: ProviderConfig;
      forceQuestionIds?: string[];
      sourceFrame?: { tabId: number; frameId: number; documentId?: string };
    }
  | { op: 'status'; html: string; url: string }
  | { op: 'draft-snapshot'; html: string; url: string }
  | {
      op: 'solve';
      answerConcurrency?: number;
      priority?: number;
      provider: ProviderConfig;
      imageProvider?: ProviderConfig;
      questions: import('./domain').QuestionRecord[];
      policy: import('./domain').DraftPolicy;
    }
  | { op: 'test'; provider: ProviderConfig }
  | {
      op: 'test-vision';
      provider: ProviderConfig;
      concurrency?: number;
    };
export function rpc<T>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || '扩展通信失败');
    return response.value as T;
  });
}

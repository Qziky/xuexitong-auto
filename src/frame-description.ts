import {
  extractAccount,
  readPageStatus,
  textOf,
  taskKeyFromUrl,
} from './page-parser';
import { classifyTaskPage } from './task-context';
import { detectVerification } from './platform-access';
import { hashText } from './security';
import type { FrameInfo } from './messages';
import { describeVideo, describeMedia } from './video-player';
import { describeReader } from './learning-adapters';

/** Lightweight loaded-page metadata; never parses questions into full records. */
export function describeFrame(
  doc: Document,
  url: string,
  top: boolean,
  cookie = '',
): FrameInfo {
  const verificationRequired = Boolean(detectVerification(url, doc));
  const loginRequired = Boolean(doc.querySelector('input[type="password"]'));
  const modern = doc.querySelectorAll('.questionLi');
  const questions = modern.length ? modern : doc.querySelectorAll('.TiMu');
  const hasQuestions =
    !verificationRequired && !loginRequired && questions.length > 0;
  const status = hasQuestions ? readPageStatus(doc, url) : undefined;
  const revision = hasQuestions
    ? hashText(
        JSON.stringify([
          taskKeyFromUrl(url, doc),
          status,
          [...questions].map((q) => [
            q.id,
            q.textContent,
            [
              ...q.querySelectorAll<HTMLInputElement>('input,textarea,select'),
            ].map((n) => [n.id, n.value, n.checked]),
          ]),
        ]),
      )
    : undefined;
  return {
    learningCardIdentity: (() => {
      const address = new URL(url);
      if (!/\/knowledge\/cards$/.test(address.pathname)) return;
      const chapterId =
        address.searchParams.get('knowledgeid') ??
        address.searchParams.get('chapterId');
      if (!chapterId) return;
      const hint = doc.querySelector<HTMLInputElement>(
        'input[name="knowledgeid"],input[name="chapterId"]',
      )?.value;
      return {
        chapterId,
        cardNumber: address.searchParams.get('num') ?? '0',
        ready:
          (!hint || hint === chapterId) &&
          !doc.querySelector(
            '[data-card-loading="true"],[aria-busy="true"].ans-attach-ct',
          ),
      };
    })(),
    media:
      !verificationRequired && !loginRequired
        ? describeMedia(doc, url)
        : undefined,
    reader:
      !verificationRequired && !loginRequired ? describeReader(doc) : undefined,
    learningTargets: [...doc.querySelectorAll('iframe[data]')].flatMap((el) => {
      try {
        const d = JSON.parse(el.getAttribute('data')!);
        return [
          {
            src: new URL(el.getAttribute('src') || '', url).href,
            objectId: d.objectid ?? d.objectId,
            jobId: d.jobid ?? d._jobid,
          },
        ];
      } catch {
        return [];
      }
    }),
    hasLearningMenu:
      !verificationRequired &&
      !loginRequired &&
      !!doc.querySelector(
        '[onclick*="getTeacherAjax"],[onclick*="toOld("],[data-knowledgeid],a[href*="studentstudy"],a[href*="knowledge/cards"]',
      ),
    hasObfuscatedText:
      hasQuestions &&
      !!doc.querySelector('.TiMu .font-cxsecret,.questionLi .font-cxsecret'),
    video:
      !verificationRequired && !loginRequired
        ? describeVideo(doc, url)
        : undefined,
    url,
    top,
    accountId: extractAccount(doc, cookie),
    taskKey: taskKeyFromUrl(url, doc),
    adapter: hasQuestions ? (modern.length ? 'modern' : 'legacy') : undefined,
    loginRequired,
    verificationRequired,
    taskKind: classifyTaskPage(url, doc.referrer, doc.title),
    revision,
    taskSummary: hasQuestions
      ? {
          title:
            textOf(doc.querySelector('.ceyan_name h3')) ||
            textOf(doc.querySelector('.workTitle, .work_name, .mark_title')) ||
            doc.title,
          ...status!,
          pageMode: /\/work\/preview$/.test(new URL(url).pathname)
            ? 'preview'
            : undefined,
          questionCount: questions.length,
        }
      : undefined,
  };
}

import { parseScanDocument, inertDocument } from '../../src/scan-parser';
import { restoreSnapshot, testVision, warmOcr } from '../../src/ocr';
import { chat, solveBatch } from '../../src/provider';
import { PlatformReader } from '../../src/platform-reader';
import { PlatformAccessError } from '../../src/platform-access';
import type { OffscreenJob } from '../../src/messages';
import { loadImageBlob } from '../../src/image-loader';
import { readPageStatus, extractPage } from '../../src/page-parser';
import type { ProgressSink } from '../../src/progress';
import { parseLearningCards } from '../../src/learning-parser';
import { PlatformAdmissionClient } from '../../src/platform-admission';

const jobs = new Map<string, AbortController>();
const reader = new PlatformReader();
const admission = new PlatformAdmissionClient((message) =>
  chrome.runtime.sendMessage(message),
);
async function run(
  job: OffscreenJob,
  signal: AbortSignal,
  pulse: ProgressSink,
  jobId: string,
): Promise<unknown> {
  switch (job.op) {
    case 'learning-cards': {
      const document = inertDocument(job.html);
      return parseLearningCards(document, job.url, job.course, job.chapterId, {
        fresh: job.fresh,
        knownReadingTask: job.knownReadingTask,
      });
    }
    case 'warm-ocr':
      return warmOcr(chrome.runtime.getURL('ocr').replace(/\/$/, ''), signal);
    case 'fetch': {
      return reader.read(job.url, signal, job.scope, job.fresh, job.purpose, {
        jobId,
        progress: pulse,
        network: (context, start) => admission.request(context, start),
      });
    }
    case 'parse':
      return parseScanDocument(
        inertDocument(job.html),
        job.url,
        job.accountId,
        job.course,
      );
    case 'restore':
      return restoreSnapshot(
        job.page,
        chrome.runtime.getURL('ocr').replace(/\/$/, ''),
        signal,
        pulse,
        job.recognition,
        job.visionProvider,
        job.forceQuestionIds,
        job.sourceFrame
          ? async (image, cancel) => {
              const response = await chrome.runtime.sendMessage({
                target: 'background',
                kind: 'image-resource',
                id: jobId,
                imageId: image.id,
                resourceKey: image.resourceKey,
              });
              if (response?.block)
                throw new PlatformAccessError(response.block);
              if (!response?.ok)
                throw new Error(response?.error || '课程原图读取失败');
              const src = response.value;
              if (
                !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(
                  src,
                ) ||
                src.length > 8000000
              )
                throw new Error('课程页面返回的原图数据无效或过大');
              return loadImageBlob({ ...image, src }, job.page.url, cancel);
            }
          : undefined,
      );
    case 'status':
      return readPageStatus(inertDocument(job.html), job.url);
    case 'draft-snapshot':
      return extractPage(inertDocument(job.html), job.url);
    case 'solve':
      return solveBatch(
        job.provider,
        job.questions,
        job.policy,
        signal,
        pulse,
        job.priority,
        job.imageProvider,
      );
    case 'test': {
      const started = performance.now();
      const result = await chat(
        job.provider,
        [{ role: 'user', content: '请仅回复 OK。' }],
        signal,
        pulse,
      );
      return {
        ok: Boolean(result.trim()),
        elapsedMs: Math.round(performance.now() - started),
        text: result.slice(0, 100),
      };
    }
    case 'test-vision':
      return testVision(job.provider, signal, pulse, job.concurrency ?? 5);
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab ||
    message?.target !== 'offscreen'
  )
    return;
  if (message.kind === 'cancel') {
    jobs.get(message.id)?.abort();
    reply({ ok: true });
    return;
  }
  if (message.kind === 'cancel-all') {
    for (const controller of jobs.values()) controller.abort();
    reply({ ok: true });
    return;
  }
  if (message.kind === 'platform-check' || message.kind === 'platform-grant') {
    reply(admission.receive(message));
    return;
  }
  if (message.kind !== 'job' || typeof message.id !== 'string') return;
  const controller = new AbortController();
  jobs.set(message.id, controller);
  let sequence = 0;
  const pulseEvents: { note: string; detail?: Parameters<ProgressSink>[1] }[] =
    [];
  let lastPulseAt = 0;
  let pendingPulse:
    { note: string; detail?: Parameters<ProgressSink>[1] } | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  const sendPulse = (note: string, detail?: Parameters<ProgressSink>[1]) => {
    void chrome.runtime
      .sendMessage({
        target: 'background',
        kind: 'heartbeat',
        id: message.id,
        note,
        detail,
        events: pulseEvents.splice(0),
        sequence: ++sequence,
      })
      .catch(() => {});
  };
  const flushPulse = () => {
    if (!pendingPulse) return;
    const next = pendingPulse;
    pendingPulse = undefined;
    if (pulseTimer) clearTimeout(pulseTimer);
    pulseTimer = undefined;
    lastPulseAt = Date.now();
    sendPulse(next.note, next.detail);
  };
  const pulse: ProgressSink = (note, detail) => {
    if (!note) {
      sendPulse('', detail);
      return;
    }
    pulseEvents.push({ note, detail });
    const urgent = /(?:-end|-error|-blocked|-cancelled)$/.test(
      detail?.code ?? '',
    );
    if (urgent || pulseEvents.length >= 50 || Date.now() - lastPulseAt >= 200) {
      lastPulseAt = Date.now();
      sendPulse(note, detail);
      return;
    }
    pendingPulse = { note, detail };
    if (!pulseTimer)
      pulseTimer = setTimeout(
        () => {
          pulseTimer = undefined;
          flushPulse();
        },
        Math.max(0, 200 - (Date.now() - lastPulseAt)),
      );
  };
  const heartbeat = setInterval(() => pulse(''), 5000);
  pulse('');
  reply({ ok: true });
  run(message.job, controller.signal, pulse, message.id)
    .then(
      (value) => {
        flushPulse();
        return chrome.runtime.sendMessage({
          target: 'background',
          kind: 'job-result',
          id: message.id,
          ok: true,
          value,
        });
      },
      (error) => {
        flushPulse();
        return chrome.runtime.sendMessage({
          target: 'background',
          kind: 'job-result',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : '后台处理失败',
          block: error instanceof PlatformAccessError ? error.block : undefined,
        });
      },
    )
    .catch(() => {})
    .finally(() => {
      flushPulse();
      if (pulseTimer) clearTimeout(pulseTimer);
      clearInterval(heartbeat);
      jobs.delete(message.id);
    });
});

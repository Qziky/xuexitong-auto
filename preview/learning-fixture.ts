import {
  ReadingAdapter,
  type ReaderDescription,
} from '../src/learning-adapters';
import { VideoPlayer } from '../src/video-player';
import { discoverFramesWithIdentity } from '../src/background/frame-account';
import type { FrameRef } from '../src/background/transport';
const out = document.querySelector<HTMLOutputElement>('#result')!;
const bindings = {
  learningId: 'fixture',
  runId: 'fixture',
  itemId: 'fixture',
  accountId: 'fixture',
  lease: 'fixture',
};
const readers: ReadingAdapter[] = [];
let player: VideoPlayer | undefined;
let authorized = true;
let animation = 0;
const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function scope(root: HTMLElement): Document {
  // Real mounted nodes with a narrow query scope, using the production adapter.
  return new Proxy(document, {
    get(target, key) {
      if (key === 'body') return root;
      if (key === 'querySelector') return root.querySelector.bind(root);
      if (key === 'querySelectorAll') return root.querySelectorAll.bind(root);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
document.querySelector('#cancel')!.addEventListener('click', () => {
  authorized = false;
  readers.forEach((r) => r.pause());
  player?.pause();
  cancelAnimationFrame(animation);
  out.textContent = '已取消';
});
const input = document.querySelector<HTMLInputElement>('#pageNumber')!;
function renderPage() {
  const page = document.querySelector<HTMLElement>('.page')!;
  page.dataset.pageNumber = input.value;
  page.textContent = '第' + input.value + '页';
}
input.addEventListener('change', renderPage);
document.querySelector('#next')!.addEventListener('click', () => {
  input.value = String(Math.min(3, Number(input.value) + 1));
  renderPage();
});
document.querySelector('#previous')!.addEventListener('click', () => {
  input.value = String(Math.max(1, Number(input.value) - 1));
  renderPage();
});
document.querySelector('#run')!.addEventListener(
  'click',
  () =>
    void (async () => {
      authorized = true;
      out.textContent = '正在运行';
      readers.forEach((r) => r.pause());
      player?.pause();
      const results: Record<string, unknown> = {};
      try {
        const anonymous = {
          tabId: 10,
          frameId: 0,
          documentId: 'fixture-course',
          url: 'https://mooc1.chaoxing.com/mycourse/studentstudy',
          top: true,
          loginRequired: false,
        } as FrameRef;
        const identified = { ...anonymous, accountId: 'fixture' };
        let freshProbes = 0;
        const refreshed = await discoverFramesWithIdentity(
          async (fresh) => {
            if (fresh) freshProbes++;
            return [fresh ? identified : anonymous];
          },
          (frames) => {
            if (frames[0]?.accountId !== 'fixture')
              throw new Error('identity cache was not refreshed');
          },
          undefined,
          4,
          20,
        );
        const witnessed = await discoverFramesWithIdentity(
          async () => [anonymous],
          (frames) => {
            if (!frames.some((frame) => frame.accountId === 'fixture'))
              throw new Error('live identity witness was not verified');
          },
          undefined,
          2,
          20,
          async () => [{ ...identified, tabId: 20 }],
        );
        results.accountRecovery = {
          passed:
            freshProbes === 1 &&
            refreshed[0] === identified &&
            witnessed.length === 1 &&
            witnessed[0] === anonymous,
          forcedRefresh: freshProbes === 1 && refreshed[0] === identified,
          witnessVerified: witnessed.length === 1 && witnessed[0] === anonymous,
        };
        const root = document.querySelector<HTMLElement>('#scrollReader')!;
        root.querySelector('[data-lazy]')?.remove();
        root.scrollTop = 0;
        let lazy = false,
          lastScroll: ReaderDescription | undefined;
        root.onscroll = () => {
          if (
            !lazy &&
            root.scrollTop + root.clientHeight >= root.scrollHeight - 1
          ) {
            lazy = true;
            const page = document.createElement('section');
            page.dataset.lazy = 'true';
            page.textContent = '懒加载的第四屏';
            root.querySelector('article')!.append(page);
          }
        };
        const scrollReader = new ReadingAdapter(
          scope(root.parentElement!),
          async () => authorized,
          async (_b, state) => {
            lastScroll = state;
            document.querySelector('#scrollResult')!.textContent =
              JSON.stringify(state);
            return authorized;
          },
        );
        readers.push(scrollReader);
        await scrollReader.start({ ...bindings, lease: 'scroll' }, undefined, {
          readingIntervalMs: 250,
        });
        const by = Date.now() + 12000;
        while (!lastScroll?.finished && Date.now() < by && authorized)
          await wait(100);
        results.scroll = {
          passed:
            !!lastScroll?.finished &&
            lazy &&
            root.scrollTop + root.clientHeight >= root.scrollHeight - 1,
          lazyLoaded: lazy,
          position: root.scrollTop,
          extent: root.scrollHeight - root.clientHeight,
        };
        scrollReader.pause();
        input.value = '2';
        renderPage();
        let pdf: ReaderDescription | undefined;
        const pdfReader = new ReadingAdapter(
          scope(input.parentElement!),
          async () => authorized,
          async (_b, state) => {
            pdf = state;
            document.querySelector('#pdfResult')!.textContent =
              JSON.stringify(state);
            return authorized;
          },
        );
        readers.push(pdfReader);
        await pdfReader.start({ ...bindings, lease: 'pdf' }, undefined, {
          readingIntervalMs: 250,
        });
        const end = Date.now() + 8000;
        while (!pdf?.finished && Date.now() < end && authorized)
          await wait(100);
        results.pdf = {
          passed: pdf?.finished && pdf.currentPage === 3,
          current: pdf?.currentPage,
        };
        pdfReader.pause();
        // The native completion callback must see a real bottom scroll, not
        // merely the last page becoming the adapter's current page.
        const frame = document.createElement('iframe');
        frame.style.cssText = 'width:360px;height:320px;border:1px solid #abc';
        frame.srcdoc =
          '<style>body{margin:0;padding-bottom:20px}li{height:760px;list-style:none;background:#eef;border-bottom:1px solid #abc}</style><li id="anchor1">第一页</li><li id="anchor2">末页</li>';
        document.body.append(frame);
        await new Promise<void>((resolve) =>
          frame.addEventListener('load', () => resolve(), { once: true }),
        );
        const child = frame.contentWindow!,
          childDoc = frame.contentDocument!;
        let nativeBottom = false,
          finalPage: ReaderDescription | undefined;
        child.addEventListener('scroll', () => {
          const root = childDoc.scrollingElement!;
          if (root.scrollHeight - root.scrollTop - child.innerHeight <= 40)
            nativeBottom = true;
        });
        const pageReader = new ReadingAdapter(
          childDoc,
          async () => authorized,
          async (_b, state) => {
            finalPage = state;
            return authorized;
          },
        );
        readers.push(pageReader);
        await pageReader.start(
          { ...bindings, lease: 'native-bottom' },
          undefined,
          { readingIntervalMs: 250 },
        );
        const pageDeadline = Date.now() + 12000;
        while (!finalPage?.finished && Date.now() < pageDeadline && authorized)
          await wait(100);
        await wait(100);
        results.nativeBottom = {
          passed: !!finalPage?.finished && nativeBottom,
          pages: finalPage?.currentPage,
          nativeBottom,
        };
        pageReader.pause();
        frame.remove();
        const embedded = document.createElement('iframe');
        embedded.style.cssText =
          'width:360px;height:320px;border:1px solid #abc';
        embedded.srcdoc =
          '<style>body{margin:0}#reader{height:230px;overflow-y:auto}li{height:1500px;list-style:none;background:#eef}</style><h3>单页 DOCX</h3><div id="reader"><li id="anchor1">一页中的完整长内容</li></div>';
        document.body.append(embedded);
        await new Promise<void>((resolve) =>
          embedded.addEventListener('load', () => resolve(), { once: true }),
        );
        const embeddedDoc = embedded.contentDocument!,
          viewport = embeddedDoc.querySelector<HTMLElement>('#reader')!;
        let embeddedBottom = false,
          embeddedState: ReaderDescription | undefined;
        viewport.addEventListener('scroll', () => {
          if (
            viewport.scrollTop + viewport.clientHeight >=
            viewport.scrollHeight - 1
          )
            embeddedBottom = true;
        });
        const embeddedReader = new ReadingAdapter(
          embeddedDoc,
          async () => authorized,
          async (_b, state) => {
            embeddedState = state;
            return authorized;
          },
        );
        readers.push(embeddedReader);
        await embeddedReader.start(
          { ...bindings, lease: 'embedded-docx' },
          undefined,
          { readingIntervalMs: 250 },
        );
        const embeddedDeadline = Date.now() + 10000;
        while (
          !embeddedState?.finished &&
          Date.now() < embeddedDeadline &&
          authorized
        )
          await wait(100);
        results.embeddedDocx = {
          passed:
            !!embeddedState?.finished &&
            embeddedBottom &&
            embedded.contentWindow!.scrollY === 0,
          pages: embeddedState?.currentPage,
          position: viewport.scrollTop,
          nativeBottom: embeddedBottom,
        };
        embeddedReader.pause();
        embedded.remove();
        const communicationRoot = document.createElement('section');
        communicationRoot.innerHTML =
          '<div data-reader-scroll style="height:100px;overflow-y:auto"><article style="height:500px">通信中断夹具</article></div>';
        document.body.append(communicationRoot);
        let replyCount = 0,
          disconnectedState: ReaderDescription | undefined,
          lateReply!: (value: boolean) => void;
        const disconnectedReader = new ReadingAdapter(
          scope(communicationRoot),
          async () => authorized,
          async (_b, state) => {
            replyCount++;
            if (replyCount === 1)
              return new Promise<boolean>((resolve) => (lateReply = resolve));
            disconnectedState = state;
            return authorized;
          },
        );
        readers.push(disconnectedReader);
        const communicationStart = Date.now();
        await disconnectedReader.start({ ...bindings, lease: 'lost-reply' });
        lateReply(true);
        await wait(300);
        results.lostReaderReply = {
          passed:
            disconnectedState?.errorCode === 'reader-communication-timeout' &&
            replyCount === 2 &&
            !disconnectedState.finished,
          durationMs: Date.now() - communicationStart,
          errorCode: disconnectedState?.errorCode,
          replyCount,
        };
        disconnectedReader.pause();
        communicationRoot.remove();
        const video = document.querySelector<HTMLVideoElement>('#media')!;
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 150;
        const ctx = canvas.getContext('2d')!;
        const stream = canvas.captureStream(25);
        video.srcObject = stream;
        const draw = () => {
          ctx.fillStyle = '#284b8e';
          ctx.fillRect(0, 0, 320, 150);
          ctx.fillStyle = 'white';
          ctx.font = '20px sans-serif';
          ctx.fillText('真实视频流 ' + (Date.now() % 100000), 10, 70);
          animation = requestAnimationFrame(draw);
        };
        draw();
        player = new VideoPlayer(
          scope(video.parentElement!),
          () => location.href,
          async () => authorized,
          async (_b, state) => {
            document.querySelector('#mediaResult')!.textContent =
              JSON.stringify(state);
            return authorized;
          },
        );
        await player.play({ ...bindings, lease: 'video' });
        await wait(800);
        const before = video.currentTime;
        video.pause();
        await player.recover({ ...bindings, lease: 'recovery' });
        await wait(300);
        results.media = {
          passed:
            video.currentTime > before &&
            !video.paused &&
            video.muted &&
            video.playbackRate === 1,
          before,
          after: video.currentTime,
        };
        player.pause();
        stream.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(animation);
        out.textContent = JSON.stringify(
          {
            status: Object.values(results).every((r: any) => r.passed)
              ? 'PASS'
              : 'FAIL',
            results,
          },
          null,
          2,
        );
      } catch (error) {
        out.textContent = JSON.stringify(
          { status: 'FAIL', results, error: (error as Error).message },
          null,
          2,
        );
        player?.pause();
        readers.forEach((r) => r.pause());
        cancelAnimationFrame(animation);
      }
    })(),
);

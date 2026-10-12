import type { LearningItem, LearningSettings, PlatformBlock } from './domain';
import { assertPlatformPage, PlatformAccessError } from './platform-access';
import { extractAccount } from './page-parser';
import { LearningAdapterError, type VideoBinding } from './video-player';
import { learningSettingsDefaults } from './learning-settings';
import {
  readerView,
  readerContentReady,
  type ReaderView,
  type ReaderMode,
} from './reader-view';
export interface ReaderDescription {
  mode?: ReaderMode;
  currentPage: number;
  totalPages?: number;
  scrollPosition?: number;
  scrollExtent?: number;
  finished: boolean;
  waiting?: string;
  errorCode?: string;
  block?: PlatformBlock;
}
export interface LearningAdapter<T> {
  probe(): T | undefined;
  start(
    binding: VideoBinding,
    completion?: LearningItem['completion'],
    settings?: LearningSettings,
  ): Promise<T>;
  pause(): void;
  readCompletion(): boolean;
}
export function describeReader(doc: Document): ReaderDescription | undefined {
  const view = readerView(doc);
  return view
    ? {
        mode: view.mode,
        currentPage: 0,
        totalPages: view.total,
        scrollPosition: view.scroll?.scrollTop,
        scrollExtent: view.scroll
          ? Math.max(0, view.scroll.scrollHeight - view.scroll.clientHeight)
          : undefined,
        finished: false,
      }
    : undefined;
}
/** Local reader actions and heartbeats are independent; completion is verified by the background. */
export class ReadingAdapter implements LearningAdapter<ReaderDescription> {
  private binding?: VideoBinding;
  private timer?: ReturnType<typeof setTimeout>;
  private observer?: MutationObserver;
  private current = 0;
  private startedAt = 0;
  private lastAck = 0;
  private requiredSeconds = 0;
  private interval = 250;
  private nextAction = 0;
  private waitingSince = 0;
  private generation = 0;
  private inFlight?: VideoBinding;
  private scrollStarted = false;
  private awaitingPage?: number;
  private enteredPage?: HTMLElement;
  private pageEndEntered = false;
  private awaitingPageOffset?: number;
  private awaitingScroll?: number;
  private bottomSince?: number;
  private height = 0;
  private localFinished = false;
  private lastSent = '';
  private lastReport = 0;
  private documentUrl = '';
  private mode?: ReaderMode;
  private pending = new Set<() => void>();
  constructor(
    private doc: Document,
    private authorize: (b: VideoBinding) => Promise<boolean>,
    private send: (
      b: VideoBinding,
      state: ReaderDescription,
    ) => Promise<boolean>,
  ) {}
  probe(): ReaderDescription | undefined {
    return describeReader(this.doc);
  }
  readCompletion(): boolean {
    return (
      this.localFinished &&
      Date.now() - this.startedAt >= this.requiredSeconds * 1000
    );
  }
  async start(
    binding: VideoBinding,
    completion?: LearningItem['completion'],
    settings?: LearningSettings,
  ): Promise<ReaderDescription> {
    this.pause();
    const generation = this.generation;
    assertPlatformPage(this.doc.URL, this.doc);
    const account = extractAccount(this.doc, this.doc.cookie);
    if (account && account !== binding.accountId)
      throw new LearningAdapterError('account-changed', '阅读页面账号已变化');
    if (!readerView(this.doc, binding))
      throw new LearningAdapterError(
        'unsupported-reader',
        '未找到可控制且属于当前任务的平台阅读器，请打开检查',
      );
    if (
      !(await this.communicate(() => this.authorize(binding))) ||
      generation !== this.generation
    )
      throw new LearningAdapterError('binding-changed', '阅读任务绑定失效');
    this.binding = binding;
    this.current = 0;
    this.enteredPage = undefined;
    this.pageEndEntered = false;
    this.awaitingPageOffset = undefined;
    this.awaitingPage = this.awaitingScroll = this.bottomSince = undefined;
    this.height = 0;
    this.localFinished = false;
    this.scrollStarted = false;
    this.lastSent = '';
    this.lastReport = 0;
    this.startedAt = this.lastAck = this.waitingSince = Date.now();
    this.requiredSeconds = completion?.seconds ?? 0;
    this.interval = learningSettingsDefaults(settings).readingIntervalMs;
    this.nextAction = Date.now();
    this.documentUrl = this.doc.URL;
    this.mode = readerView(this.doc, binding)!.mode;
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(this.doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'aria-busy',
        'data-reader-page',
        'data-loaded',
        'src',
        'class',
      ],
    });
    this.doc.addEventListener('load', this.onChange, true);
    this.doc.addEventListener('scroll', this.onChange, true);
    await this.tick();
    return this.description();
  }
  pause(): void {
    this.generation++;
    for (const cancel of this.pending) cancel();
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.observer?.disconnect();
    this.observer = undefined;
    this.doc.removeEventListener('load', this.onChange, true);
    this.doc.removeEventListener('scroll', this.onChange, true);
    this.binding = undefined;
  }
  /** A lost extension reply must not hold the reader's action/heartbeat loop. */
  private communicate<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        if (error)
          reject(
            error instanceof Error &&
              /message (?:channel|port).*closed|receiving end does not exist|no document|extension context invalidated/i.test(
                error.message,
              )
              ? new LearningAdapterError(
                  'reader-communication-timeout',
                  '阅读页面通信中断，正在重新核对任务',
                )
              : error,
          );
        else resolve(value!);
      };
      const cancel = () =>
        finish(
          new LearningAdapterError(
            'binding-changed',
            '阅读任务绑定已失效，操作取消',
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new LearningAdapterError(
              'reader-communication-timeout',
              '阅读页面与后台通信超过 3 秒没有响应，正在重新核对任务',
            ),
          ),
        3000,
      );
      this.pending.add(cancel);
      try {
        Promise.resolve(work()).then(
          (value) => finish(undefined, value),
          finish,
        );
      } catch (error) {
        finish(error);
      }
    });
  }
  private onChange = () => this.schedule();
  private schedule(): void {
    if (this.binding && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.tick();
      }, 250);
  }
  private description(
    waiting?: string,
    errorCode?: string,
    view = readerView(this.doc, this.binding),
  ): ReaderDescription {
    return {
      mode: this.mode,
      currentPage: this.current,
      totalPages: view?.total,
      scrollPosition: view?.scroll?.scrollTop,
      scrollExtent: view?.scroll
        ? Math.max(0, view.scroll.scrollHeight - view.scroll.clientHeight)
        : undefined,
      finished: !errorCode && this.readCompletion(),
      waiting,
      errorCode,
    };
  }
  private wait(
    message: string,
    code: string,
    timeoutMessage = message,
  ): string {
    if (Date.now() - this.waitingSince >= 30000)
      throw new LearningAdapterError(code, timeoutMessage);
    return message;
  }
  private advance(): void {
    this.waitingSince = Date.now();
  }
  private pageStep(view: ReaderView): string | undefined {
    if (!view.total || (!view.current && view.mode !== 'pages'))
      return this.wait('等待读取阅读器页码', 'reader-initialization');
    if (this.awaitingPage !== undefined) {
      if (view.current !== this.awaitingPage)
        return this.wait('等待阅读器翻页', 'reader-page-timeout');
      this.awaitingPage = undefined;
    }
    if (this.current >= view.total) {
      this.localFinished = true;
      return;
    }
    if (Date.now() < this.nextAction) return '等待下一次阅读动作';
    if (view.mode !== 'pages' && view.current !== this.current + 1) {
      const target = this.current + 1;
      if (view.current === this.current || this.current === 0) {
        if (view.pageInput && this.current === 0) {
          view.pageInput.value = '1';
          view.pageInput.dispatchEvent(new Event('input', { bubbles: true }));
          view.pageInput.dispatchEvent(new Event('change', { bubbles: true }));
          this.awaitingPage = 1;
        } else {
          const control = view.current! > target ? view.previous : view.next;
          if (!control)
            return this.wait('阅读器翻页入口不可用', 'reader-page-timeout');
          control.click();
          this.awaitingPage = view.current! + (view.current! > target ? -1 : 1);
        }
        this.waitingSince = Date.now();
        this.nextAction = Date.now() + this.interval;
        return '等待阅读器翻页';
      }
      throw new LearningAdapterError(
        'reader-changed',
        '阅读器页码发生了非预期变化',
      );
    }
    const page =
      view.mode === 'pdfjs'
        ? (view.pages.find(
            (p) => Number(p.getAttribute('data-page-number')) === view.current,
          ) ?? (view.pages.length === 1 ? view.pages[0] : undefined))
        : view.pages[view.mode === 'pages' ? this.current : 0];
    if (!page) return this.wait('等待阅读器内容加载', 'reader-load-timeout');
    // Lazy images are activated by entering the page, not by waiting offscreen.
    if (this.enteredPage !== page) {
      page.scrollIntoView({ block: 'start', behavior: 'instant' });
      this.enteredPage = page;
      this.pageEndEntered = false;
    }
    if (!readerContentReady(page))
      return this.wait(
        '等待页面图片加载',
        'reader-image-timeout',
        '页面图片加载失败',
      );
    if (view.mode === 'pdfjs' && page.getAttribute('data-loaded') === 'false')
      return this.wait('等待 PDF 页面渲染', 'reader-load-timeout');
    const bounds = page.getBoundingClientRect();
    const scroller =
      view.mode === 'pages' && view.scroll !== this.doc.scrollingElement
        ? view.scroll
        : undefined;
    const viewportTop = scroller
      ? scroller.getBoundingClientRect().top + scroller.clientTop
      : 0;
    const viewportHeight =
      scroller?.clientHeight ?? this.doc.defaultView?.innerHeight ?? 0;
    const viewportBottom = viewportTop + viewportHeight;
    const offset = () => scroller?.scrollTop ?? this.doc.defaultView?.scrollY;
    if (
      bounds.height > 0 &&
      viewportHeight > 0 &&
      (bounds.bottom <= viewportTop || bounds.top >= viewportBottom)
    )
      return this.wait('阅读页面未进入可视区域', 'reader-scroll-timeout');
    // Entering the final page's top does not reach the document's bottom.
    // Native readers report completion from their real scroll event.
    if (view.mode === 'pages' && viewportHeight > 0 && bounds.height > 0) {
      if (this.awaitingPageOffset !== undefined) {
        if (offset() === this.awaitingPageOffset)
          return this.wait('阅读器滚动没有产生位移', 'reader-scroll-timeout');
        this.awaitingPageOffset = undefined;
        this.advance();
      }
      if (bounds.bottom > viewportBottom + 1) {
        this.bottomSince = undefined;
        if (Date.now() < this.nextAction) return '等待下一次阅读动作';
        this.awaitingPageOffset = offset();
        const by = Math.min(viewportHeight, bounds.bottom - viewportBottom);
        if (scroller) scroller.scrollTop += by;
        else this.doc.defaultView?.scrollBy({ top: by, behavior: 'instant' });
        this.nextAction = Date.now() + this.interval;
        return this.wait('正在阅读当前页下半部分', 'reader-scroll-timeout');
      }
      if (this.current + 1 === view.total && !this.pageEndEntered) {
        page.scrollIntoView({ block: 'end', behavior: 'instant' });
        if (scroller || view.root === this.doc.body) {
          const scrolling = scroller ?? this.doc.scrollingElement;
          if (scrolling)
            scrolling.scrollTop = Math.max(
              0,
              scrolling.scrollHeight - scrolling.clientHeight,
            );
        }
        this.pageEndEntered = true;
        this.bottomSince = Date.now();
        this.advance();
        return '等待末页滚动完成';
      }
      if (this.current + 1 === view.total) {
        this.bottomSince ??= Date.now();
        if (Date.now() - this.bottomSince < 1000) return '等待底部内容稳定';
      }
    }
    this.current++;
    this.enteredPage = undefined;
    this.advance();
    if (view.mode === 'pages') this.nextAction = Date.now() + this.interval;
    if (this.current >= view.total) this.localFinished = true;
    else if (view.mode !== 'pages') return this.pageStep(view);
  }
  private scrollStep(view: ReaderView): string | undefined {
    const root = view.scroll!;
    if (!readerContentReady(root, true)) {
      this.bottomSince = undefined;
      this.localFinished = false;
      return this.wait(
        '等待页面图片加载',
        'reader-image-timeout',
        '页面图片加载失败',
      );
    }
    if (root.clientHeight <= 0)
      return this.wait('等待阅读区域布局', 'reader-initialization');
    if (this.awaitingScroll !== undefined) {
      if (Math.abs(root.scrollTop - this.awaitingScroll) < 1)
        return this.wait('阅读器滚动没有产生位移', 'reader-scroll-timeout');
      this.awaitingScroll = undefined;
      this.advance();
    }
    if (this.height !== root.scrollHeight) {
      this.height = root.scrollHeight;
      this.bottomSince = undefined;
      this.localFinished = false;
    }
    const extent = Math.max(0, root.scrollHeight - root.clientHeight);
    if (!this.scrollStarted) {
      this.scrollStarted = true;
      if (root.scrollTop > 1) {
        this.awaitingScroll = root.scrollTop;
        root.scrollTop = 0;
        this.waitingSince = Date.now();
        return '返回阅读器顶部';
      }
    }
    if (root.scrollTop >= extent - 1) {
      this.bottomSince ??= Date.now();
      this.localFinished = Date.now() - this.bottomSince >= 1000;
      return this.localFinished ? undefined : '等待底部内容稳定';
    }
    this.bottomSince = undefined;
    this.localFinished = false;
    if (Date.now() >= this.nextAction) {
      this.awaitingScroll = root.scrollTop;
      root.scrollTop = Math.min(extent, root.scrollTop + root.clientHeight);
      this.waitingSince = Date.now();
      this.nextAction = Date.now() + this.interval;
    }
    return '正在逐屏阅读';
  }
  private async tick(): Promise<void> {
    if (!this.binding || this.inFlight === this.binding) return;
    const binding = this.binding,
      generation = this.generation;
    this.inFlight = binding;
    const active = () =>
      this.binding === binding && this.generation === generation;
    try {
      assertPlatformPage(this.doc.URL, this.doc);
      if (this.doc.URL !== this.documentUrl)
        throw new LearningAdapterError('reader-changed', '阅读文档身份已变化');
      if (Date.now() - this.lastAck >= 60000)
        throw new LearningAdapterError(
          'reader-communication-timeout',
          '阅读页面未收到后台确认，正在重新核对任务',
        );
      const view = readerView(this.doc, binding);
      if (!view || view.mode !== this.mode)
        throw new LearningAdapterError(
          'reader-changed',
          '阅读器归属或结构已变化',
        );
      const before = this.description(undefined, undefined, view);
      const unchanged =
        this.lastSent &&
        JSON.stringify({
          ...before,
          waiting: JSON.parse(this.lastSent).waiting,
        }) === this.lastSent;
      if (
        Date.now() < this.nextAction &&
        unchanged &&
        Date.now() - this.lastReport < 5000
      )
        return;
      if (
        this.localFinished &&
        unchanged &&
        !before.finished &&
        Date.now() - this.lastReport < 5000
      )
        return;
      if (!(await this.communicate(() => this.authorize(binding)))) {
        if (active()) this.pause();
        return;
      }
      if (!active()) return;
      let waiting =
        view.mode === 'scroll' ? this.scrollStep(view) : this.pageStep(view);
      if (this.localFinished && !this.readCompletion())
        waiting = '等待平台要求的阅读时长';
      const description = this.description(waiting, undefined, view),
        digest = JSON.stringify(description);
      if (
        description.finished ||
        (digest !== this.lastSent && Date.now() - this.lastReport >= 200) ||
        Date.now() - this.lastReport >= 5000 ||
        !this.lastSent
      ) {
        const accepted = await this.communicate(() =>
          this.send(binding, description),
        );
        if (!active()) return;
        this.lastReport = this.lastAck = Date.now();
        this.lastSent = digest;
        if (!accepted || description.finished) this.pause();
      }
    } catch (error) {
      if (active()) {
        await this.communicate(() =>
          this.send(binding, {
            ...this.description(
              error instanceof Error ? error.message : '阅读失败',
              error instanceof LearningAdapterError
                ? error.code
                : 'reader-failure',
            ),
            block:
              error instanceof PlatformAccessError ? error.block : undefined,
          }),
        ).catch(() => false);
        if (active()) this.pause();
      }
    } finally {
      if (this.inFlight === binding) this.inFlight = undefined;
      if (active()) this.schedule();
    }
  }
}

import { assertPlatformPage, PlatformAccessError } from './platform-access';
import { extractAccount } from './page-parser';
import type { LearningSettings } from './domain';
import { learningSettingsDefaults } from './learning-settings';
import type { LearningAdapter } from './learning-adapters';
export interface VideoBinding {
  learningId: string;
  runId: string;
  itemId: string;
  accountId: string;
  objectId?: string;
  jobId?: string;
  targetId?: string;
  lease?: string;
  documentId?: string;
}
export interface VideoDescription {
  position: number;
  duration?: number;
  paused: boolean;
  ended: boolean;
  readyState: number;
  objectId?: string;
  targetId?: string;
  kind?: 'video' | 'audio';
  errorCode?: string;
  sourceReady?: boolean;
  blockedQuestion?: boolean;
  block?: import('./domain').PlatformBlock;
  actualPlaybackRate?: number;
  speedStatus?: 'applied' | 'unsupported' | 'overridden';
}
export class LearningAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function objectIdFor(el: Element, url: string): string | undefined {
  const p = new URL(url).searchParams;
  return (
    el.getAttribute('data-objectid') ??
    el.getAttribute('objectid') ??
    p.get('objectid') ??
    p.get('objectId') ??
    undefined
  );
}
function mediaId(el: Element, index: number): string {
  return el.id || 'media:' + index;
}
export function declaredMediaSource(el: HTMLMediaElement): string {
  return [
    el.getAttribute('src') ?? '',
    ...[...el.querySelectorAll('source')].map(
      (n) => n.getAttribute('src') ?? '',
    ),
  ]
    .filter(Boolean)
    .join('|');
}
export function describeMedia(doc: Document, url: string): VideoDescription[] {
  return [...doc.querySelectorAll<HTMLMediaElement>('video,audio')].map(
    (media, index) => ({
      kind: media.tagName.toLowerCase() as 'video' | 'audio',
      targetId: mediaId(media, index),
      objectId: objectIdFor(media, url),
      position: media.currentTime || 0,
      actualPlaybackRate: media.playbackRate,
      duration: Number.isFinite(media.duration) ? media.duration : undefined,
      paused: media.paused,
      ended: media.ended,
      readyState: media.readyState,
      sourceReady: !!(
        media.currentSrc ||
        media.getAttribute('src') ||
        media.querySelector('source[src]')
      ),
      errorCode: media.error
        ? media.error.code === 4
          ? 'unsupported-source'
          : 'media-network'
        : undefined,
      blockedQuestion: [
        ...doc.querySelectorAll<HTMLElement>(
          '.videoquiz,.ans-videoquiz,.quiz-container,[data-video-question]',
        ),
      ].some(
        (n) =>
          n.getClientRects().length > 0 &&
          getComputedStyle(n).display !== 'none',
      ),
    }),
  );
}
export function describeVideo(
  doc: Document,
  url: string,
): VideoDescription | undefined {
  const videos = describeMedia(doc, url).filter((v) => v.kind === 'video');
  return videos.length === 1 ? videos[0] : undefined;
}
export function playbackFailure(error: unknown): LearningAdapterError {
  const name =
    error instanceof Error ? error.name + ' ' + error.message : String(error);
  if (/NotAllowedError/.test(name))
    return new LearningAdapterError(
      'autoplay-blocked',
      '浏览器阻止了自动播放，需要前台播放或点击播放按钮',
    );
  if (/NotSupportedError/.test(name))
    return new LearningAdapterError(
      'unsupported-source',
      '播放器不支持当前媒体资源',
    );
  if (/AbortError/.test(name))
    return new LearningAdapterError(
      'media-aborted',
      '播放器在加载或页面变化时中断',
    );
  if (error instanceof LearningAdapterError) return error;
  return new LearningAdapterError(
    'media-network',
    '播放请求失败，请检查媒体资源或网络',
  );
}
/** Use only rates advertised by the native player; never force a restricted rate. */
export function applyPlaybackPreference(
  media: HTMLMediaElement,
  preferred: 1 | 2,
): 'applied' | 'unsupported' {
  const root = media.closest('.video-js') ?? media.parentElement;
  if (preferred === 1) {
    media.playbackRate = 1;
    return 'applied';
  }
  const control = [
    ...(root?.querySelectorAll<HTMLElement>(
      '.vjs-playback-rate-menu-item,.vjs-playback-rate .vjs-menu-item,[data-playback-rate]',
    ) ?? []),
  ].find((n) => {
    const value =
      n.getAttribute('data-playback-rate') ??
      n.querySelector('.vjs-menu-item-text')?.textContent ??
      n.textContent ??
      '';
    return /^2\s*(?:x|×|倍|倍速)?$/i.test(value.trim());
  });
  if (control) {
    control.click();
    if (media.playbackRate === 2) return 'applied';
  }
  media.playbackRate = 1;
  return 'unsupported';
}
/** Native media only. Platform progress listeners stay attached to the original player. */
export class VideoPlayer implements LearningAdapter<VideoDescription> {
  private binding?: VideoBinding;
  private video?: HTMLMediaElement;
  private timer?: ReturnType<typeof setInterval>;
  private lastAck = 0;
  private sending?: VideoBinding;
  private generation = 0;
  private startup?: AbortController;
  private source = '';
  private resolvedSource = '';
  private sourceObject?: MediaProvider | null;
  private reportTimer?: ReturnType<typeof setTimeout>;
  private lastReport = 0;
  private lastDescription = '';
  private settings?: LearningSettings;
  private speedStatus?: 'applied' | 'unsupported' | 'overridden';
  private original?: { media: HTMLMediaElement; muted: boolean; rate: number };
  private onChange = () => {
    if (this.startup) return;
    if (!this.reportTimer)
      this.reportTimer = setTimeout(() => {
        this.reportTimer = undefined;
        void this.report();
      }, 200);
  };
  private onEnded = () => void this.report();
  constructor(
    private readonly doc: Document,
    private readonly url: () => string,
    private readonly authorize: (binding: VideoBinding) => Promise<boolean>,
    private readonly send: (
      binding: VideoBinding,
      video: VideoDescription,
    ) => Promise<boolean>,
  ) {}
  probe(): VideoDescription | undefined {
    const media = describeMedia(this.doc, this.url());
    return this.describe() ?? (media.length === 1 ? media[0] : undefined);
  }
  start(binding: VideoBinding): Promise<VideoDescription> {
    return this.play(binding);
  }
  readCompletion(): boolean {
    return this.describe()?.ended === true;
  }
  async recover(
    binding: VideoBinding,
    settings = this.settings,
  ): Promise<VideoDescription> {
    return this.play(binding, true, true, settings);
  }
  async play(
    binding: VideoBinding,
    recovery = false,
    requireProgress = recovery,
    settings = this.settings,
  ): Promise<VideoDescription> {
    const previous = this.video,
      oldSource = this.source,
      oldObject = this.sourceObject;
    this.pause();
    const generation = this.generation;
    assertPlatformPage(this.url(), this.doc);
    const account = extractAccount(this.doc, this.doc.cookie);
    if (account && account !== binding.accountId)
      throw new LearningAdapterError('account-changed', '视频页面账号已变化');
    const media = [
      ...this.doc.querySelectorAll<HTMLMediaElement>('video,audio'),
    ];
    const matches = media.filter((el, i) =>
      binding.targetId
        ? mediaId(el, i) === binding.targetId
        : binding.objectId && objectIdFor(el, this.url())
          ? objectIdFor(el, this.url()) === binding.objectId
          : media.length === 1,
    );
    if (matches.length !== 1)
      throw new LearningAdapterError(
        'ambiguous-player',
        '无法定位该任务对应的播放器',
      );
    const el = matches[0]!;
    if (
      recovery &&
      (!previous ||
        el !== previous ||
        (oldSource &&
          declaredMediaSource(el) &&
          declaredMediaSource(el) !== oldSource) ||
        (oldObject && el.srcObject && oldObject !== el.srcObject))
    )
      throw new LearningAdapterError(
        'binding-changed',
        '播放器或媒体源已变化，需要重新绑定任务卡片',
      );
    const objectId = objectIdFor(el, this.url());
    if (binding.objectId && objectId && objectId !== binding.objectId)
      throw new LearningAdapterError('binding-changed', '播放器任务已变化');
    if (!(await this.authorize(binding)))
      throw new LearningAdapterError('binding-changed', '播放执行绑定已失效');
    if (generation !== this.generation)
      throw new LearningAdapterError('binding-changed', '播放已取消');
    this.binding = binding;
    this.video = el;
    this.settings = learningSettingsDefaults(settings);
    this.original = { media: el, muted: el.muted, rate: el.playbackRate };
    this.source = declaredMediaSource(el);
    this.resolvedSource = el.currentSrc;
    this.sourceObject = el.srcObject;
    this.lastDescription = '';
    this.lastReport = 0;
    this.lastAck = Date.now();
    const startup = (this.startup = new AbortController());
    el.muted = true;
    this.speedStatus = undefined;
    el.addEventListener('ended', this.onEnded);
    for (const event of [
      'error',
      'pause',
      'timeupdate',
      'loadedmetadata',
      'emptied',
      'ratechange',
    ])
      el.addEventListener(event, this.onChange);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (recovery && (el.error || el.readyState < 2)) el.load();
      // The original button may initialize Video.js and the platform's progress machinery.
      const root = el.closest('.video-js') ?? el.parentElement;
      const start = root?.querySelector<HTMLElement>(
        '.vjs-big-play-button,[data-action="play"]',
      );
      if (el.paused && start && getComputedStyle(start).display !== 'none')
        start.click();
      await Promise.race([
        (async () => {
          const startPosition = el.currentTime;
          await el.play();
          if (
            generation !== this.generation ||
            this.binding !== binding ||
            !el.isConnected
          )
            throw new LearningAdapterError(
              'binding-changed',
              '播放已取消或页面已变化',
            );
          this.speedStatus = applyPlaybackPreference(
            el,
            this.settings?.preferredPlaybackRate ?? 2,
          );
          if (!requireProgress) return;
          while (el.currentTime <= startPosition + 0.05) {
            if (
              generation !== this.generation ||
              this.binding !== binding ||
              startup.signal.aborted ||
              !el.isConnected ||
              !(await this.authorize(binding))
            )
              throw new LearningAdapterError(
                'binding-changed',
                '播放恢复已取消或绑定失效',
              );
            assertPlatformPage(this.url(), this.doc);
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
          }
        })(),
        new Promise<never>((_, reject) =>
          startup.signal.addEventListener(
            'abort',
            () =>
              reject(new LearningAdapterError('binding-changed', '播放已取消')),
            { once: true },
          ),
        ),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new LearningAdapterError(
                  'startup-timeout',
                  recovery
                    ? '播放恢复超过 30 秒仍无实际进展'
                    : '播放器启动等待超过 30 秒',
                ),
              ),
            29000,
          );
        }),
      ]);
      if (
        this.binding !== binding ||
        !el.isConnected ||
        !(await this.authorize(binding))
      )
        throw new LearningAdapterError(
          'binding-changed',
          '播放已取消或页面已变化',
        );
      if (el.paused && !el.ended)
        throw new LearningAdapterError(
          'startup-timeout',
          '播放器尚未实际开始播放',
        );
    } catch (error) {
      if (this.binding === binding) this.pause();
      throw playbackFailure(error);
    } finally {
      clearTimeout(deadline);
      if (this.startup === startup) this.startup = undefined;
    }
    this.timer = setInterval(() => {
      if (Date.now() - this.lastAck > 60000) this.pause();
      else void this.report();
    }, 5000);
    await this.report();
    return this.describe()!;
  }
  describe(): VideoDescription | undefined {
    if (!this.video || !this.binding) return undefined;
    const info = describeMedia(this.doc, this.url()).find(
      (v) =>
        v.targetId ===
        mediaId(
          this.video!,
          [...this.doc.querySelectorAll('video,audio')].indexOf(this.video!),
        ),
    );
    if (!this.video.isConnected || !info)
      return {
        position: this.video.currentTime || 0,
        paused: true,
        ended: false,
        readyState: 0,
        errorCode: 'player-replaced',
      };
    const source = declaredMediaSource(this.video);
    const resolved = this.video.currentSrc;
    if (
      !source &&
      resolved &&
      this.resolvedSource &&
      resolved !== this.resolvedSource
    )
      return { ...info, errorCode: 'media-source-changed' };
    if (resolved && !this.resolvedSource) this.resolvedSource = resolved;
    if (
      (source && this.source && source !== this.source) ||
      (this.sourceObject &&
        this.video.srcObject &&
        this.sourceObject !== this.video.srcObject)
    )
      return { ...info, errorCode: 'media-source-changed' };
    if (source && !this.source) this.source = source;
    return {
      ...info,
      speedStatus:
        this.speedStatus === 'applied' &&
        info.actualPlaybackRate !== (this.settings?.preferredPlaybackRate ?? 2)
          ? 'overridden'
          : this.speedStatus,
    };
  }
  pause(page = false): void {
    this.generation++;
    this.startup?.abort();
    this.startup = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = undefined;
    this.binding = undefined;
    this.video?.removeEventListener('ended', this.onEnded);
    for (const event of [
      'error',
      'pause',
      'timeupdate',
      'loadedmetadata',
      'emptied',
      'ratechange',
    ])
      this.video?.removeEventListener(event, this.onChange);
    this.video?.pause();
    if (
      this.original &&
      this.original.media === this.video &&
      this.video?.isConnected &&
      declaredMediaSource(this.video) === this.source
    ) {
      this.video.muted = this.original.muted;
      this.video.playbackRate = this.original.rate;
    }
    this.original = undefined;
    this.video = undefined;
    if (page)
      for (const media of this.doc.querySelectorAll<HTMLMediaElement>(
        'video,audio',
      ))
        media.pause();
  }
  async pauseUnbound(): Promise<void> {
    const binding = this.binding;
    if (binding && (await this.authorize(binding)) && this.binding === binding)
      return;
    this.pause(true);
  }
  private async report(): Promise<void> {
    if (!this.binding || this.sending === this.binding) return;
    const binding = this.binding,
      info = this.describe();
    if (!info) {
      this.pause();
      return;
    }
    this.sending = binding;
    try {
      try {
        assertPlatformPage(this.url(), this.doc);
      } catch (error) {
        if (error instanceof PlatformAccessError) info.block = error.block;
        else throw error;
      }
      const digest = JSON.stringify(info);
      if (
        !info.block &&
        !info.errorCode &&
        digest === this.lastDescription &&
        Date.now() - this.lastReport < 5000
      )
        return;
      const active = await this.send(binding, info);
      if (this.binding !== binding) return;
      if (!active) this.pause();
      else {
        this.lastAck = this.lastReport = Date.now();
        this.lastDescription = digest;
      }
    } catch {
      if (Date.now() - this.lastAck > 60000) this.pause();
    } finally {
      if (this.sending === binding) this.sending = undefined;
    }
  }
}

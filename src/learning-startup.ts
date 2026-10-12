import type { PlatformBlock } from './domain';
import { PlatformAccessError } from './platform-access';
import type { VideoBinding } from './video-player';

export interface LearningStartupEvent {
  state: 'started' | 'failed';
  error?: string;
  errorCode?: string;
  block?: PlatformBlock;
}
export interface LearningStartupReceipt {
  accepted: true;
  lease?: string;
}

/** Reply before native initialization; its outcome travels in a separate bound event. */
export class LearningStarter {
  private binding?: VideoBinding;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly notify: (
      binding: VideoBinding,
      result: LearningStartupEvent,
    ) => Promise<void>,
  ) {}
  launch(
    binding: VideoBinding,
    work: () => Promise<unknown>,
  ): LearningStartupReceipt {
    if (binding.lease && this.binding?.lease === binding.lease)
      return { accepted: true, lease: binding.lease };
    this.cancel();
    this.binding = binding;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.binding !== binding) return;
      void (async () => {
        let result: LearningStartupEvent;
        try {
          await work();
          result = { state: 'started' };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : '资源启动失败';
          const disconnected =
            /message (?:channel|port).*closed|receiving end does not exist|could not establish connection|extension context invalidated/i.test(
              message,
            );
          result = {
            state: 'failed',
            error: disconnected
              ? '页面通信中断，正在重新连接播放器或阅读器'
              : message,
            errorCode: disconnected
              ? 'frame-disconnected'
              : typeof error === 'object' && error !== null && 'code' in error
                ? String(error.code)
                : 'resource-startup',
            block:
              error instanceof PlatformAccessError ? error.block : undefined,
          };
        }
        if (this.binding === binding)
          await this.notify(binding, result).catch(() => {});
      })();
    }, 0);
    return { accepted: true, lease: binding.lease };
  }
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.binding = undefined;
  }
}

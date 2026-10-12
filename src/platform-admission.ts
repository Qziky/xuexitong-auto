import type { NetworkReadContext } from './platform-reader';
import { PlatformAccessError } from './platform-access';
import type { PlatformBlock } from './domain';

export interface PlatformAdmissionRequest {
  target: 'background';
  kind: 'platform-request';
  id: string;
  url: string;
  scope?: string;
  purpose?: NetworkReadContext['purpose'];
  fresh: boolean;
  jobIds: string[];
}
interface Admission {
  context: NetworkReadContext;
  start(): Promise<Response>;
  resolve(response: Response | Promise<Response>): void;
  reject(error: Error): void;
}
/** Request receipt and permission are separate messages; no response channel waits for a turn. */
export class PlatformAdmissionClient {
  private pending = new Map<string, Admission>();
  constructor(private readonly send: (message: unknown) => Promise<any>) {}
  request(
    context: NetworkReadContext,
    start: () => Promise<Response>,
  ): Promise<Response> {
    if (context.signal.aborted) return Promise.reject(new Error('操作已取消'));
    const id = crypto.randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const cancel = () => {
        if (!this.pending.delete(id)) return;
        void this.send({
          target: 'background',
          kind: 'platform-cancel',
          id,
        }).catch(() => {});
        reject(new Error('操作已取消'));
      };
      const cleanup = () => {
        this.pending.delete(id);
        context.signal.removeEventListener('abort', cancel);
      };
      this.pending.set(id, {
        context,
        start,
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      context.signal.addEventListener('abort', cancel, { once: true });
      const message: PlatformAdmissionRequest = {
        target: 'background',
        kind: 'platform-request',
        id,
        url: context.url,
        scope: context.scope,
        purpose: context.purpose,
        fresh: context.fresh,
        jobIds: context.jobIds(),
      };
      void this.send(message).then(
        (ack) => {
          if (!ack?.ok)
            this.pending.get(id)?.reject(new Error('后台未能接收平台访问申请'));
        },
        () => this.pending.get(id)?.reject(new Error('无法连接平台访问调度')),
      );
    });
  }
  receive(message: {
    kind: string;
    id: string;
    ok?: boolean;
    error?: string;
    block?: PlatformBlock;
  }): { ok: boolean; jobIds?: string[]; startedAt?: number } {
    const entry = this.pending.get(message.id);
    if (!entry || entry.context.signal.aborted) return { ok: false };
    if (message.kind === 'platform-check')
      return { ok: true, jobIds: entry.context.jobIds() };
    if (message.kind !== 'platform-grant') return { ok: false };
    if (!message.ok) {
      entry.reject(
        message.block
          ? new PlatformAccessError(message.block)
          : new Error(message.error ?? '平台访问已中断'),
      );
      return { ok: true };
    }
    try {
      const startedAt = Date.now();
      // start() dispatches fetch synchronously; only its HTTP response remains asynchronous.
      const response = entry.start();
      entry.resolve(response);
      return { ok: true, startedAt };
    } catch (error) {
      entry.reject(
        error instanceof Error ? error : new Error('页面读取未能启动'),
      );
      return { ok: false };
    }
  }
}

/** A bounded service channel, serial by default, with FIFO within a priority. */
export class SerialChannel {
  private active = 0;
  private limit = 1;
  private sequence = 0;
  private queue: {
    priority: number;
    sequence: number;
    resolve(release: () => void): void;
    reject(error: Error): void;
    signal?: AbortSignal;
    cancel?: () => void;
  }[] = [];
  /** Retain serial compatibility unless the caller explicitly supplies a limit. */
  constructor(limit = 1) {
    this.setLimit(limit);
  }
  /** Apply new capacity without interrupting requests already holding a slot. */
  setLimit(limit: number): void {
    this.limit = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 1;
    this.pump();
  }
  /** Report scheduling counts without exposing request data. */
  details() {
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.limit,
    };
  }
  /** Acquire a slot; aborting removes only this waiting request. */
  acquire(signal?: AbortSignal, priority = 0): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('请求已取消'));
        return;
      }
      const item = {
        priority,
        sequence: ++this.sequence,
        resolve,
        reject,
        signal,
      } as (typeof this.queue)[number];
      item.cancel = () => {
        this.queue = this.queue.filter((v) => v !== item);
        reject(new Error('请求已取消'));
      };
      signal?.addEventListener('abort', item.cancel, { once: true });
      this.queue.push(item);
      this.pump();
    });
  }
  /** Fill available slots by priority and release each slot at most once. */
  private pump(): void {
    this.queue.sort(
      (a, b) => b.priority - a.priority || a.sequence - b.sequence,
    );
    while (this.active < this.limit && this.queue.length) {
      const item = this.queue.shift()!;
      item.signal?.removeEventListener('abort', item.cancel!);
      if (item.signal?.aborted) {
        item.reject(new Error('请求已取消'));
        continue;
      }
      this.active++;
      let released = false;
      item.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
  }
}

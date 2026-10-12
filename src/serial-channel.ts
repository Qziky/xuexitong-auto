/** A single service channel with FIFO ordering within a priority. */
export class SerialChannel {
  private active = false;
  private sequence = 0;
  private queue: {
    priority: number;
    sequence: number;
    resolve(release: () => void): void;
    reject(error: Error): void;
    signal?: AbortSignal;
    cancel?: () => void;
  }[] = [];
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
  private pump(): void {
    if (this.active) return;
    this.queue.sort(
      (a, b) => b.priority - a.priority || a.sequence - b.sequence,
    );
    const item = this.queue.shift();
    if (!item) return;
    item.signal?.removeEventListener('abort', item.cancel!);
    this.active = true;
    let released = false;
    item.resolve(() => {
      if (released) return;
      released = true;
      this.active = false;
      this.pump();
    });
  }
}

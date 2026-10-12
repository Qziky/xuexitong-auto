/** Bounded reusable resources. Cancelling one lease never disposes another job. */
export class ResourcePool<T> {
  private slots: { value: Promise<T>; busy: boolean; broken: boolean }[] = [];
  private waiters: {
    resolve: (value: ResourceLease<T>) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }[] = [];
  constructor(
    private limit: number,
    private create: () => Promise<T>,
    private dispose: (value: T) => Promise<unknown> | unknown,
  ) {}

  acquire(signal?: AbortSignal): Promise<ResourceLease<T>> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('操作已取消'));
        return;
      }
      const waiter = {
        resolve,
        reject,
        signal,
        abort: undefined as (() => void) | undefined,
      };
      waiter.abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('操作已取消'));
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }
  private pump(): void {
    while (this.waiters.length) {
      let slot = this.slots.find((s) => !s.busy && !s.broken);
      if (!slot && this.slots.length < this.limit) {
        slot = {
          value: Promise.resolve().then(this.create),
          busy: false,
          broken: false,
        };
        this.slots.push(slot);
      }
      if (!slot) return;
      const waiter = this.waiters.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.abort!);
      if (waiter.signal?.aborted) {
        waiter.reject(new Error('操作已取消'));
        continue;
      }
      slot.busy = true;
      const selected = slot;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (selected.broken) {
          void selected.value
            .then(this.dispose, () => {})
            .finally(() => {
              this.slots = this.slots.filter((s) => s !== selected);
              this.pump();
            });
        } else {
          selected.busy = false;
          this.pump();
        }
      };
      const invalidate = () => {
        selected.broken = true;
      };
      const abort = () => {
        invalidate();
        release();
        waiter.reject(new Error('操作已取消'));
      };
      waiter.signal?.addEventListener('abort', abort, { once: true });
      selected.value.then(
        (value) => {
          waiter.signal?.removeEventListener('abort', abort);
          if (!released) waiter.resolve({ value, release, invalidate });
        },
        (error) => {
          waiter.signal?.removeEventListener('abort', abort);
          invalidate();
          if (this.slots.length > 1) this.limit = 1;
          release();
          waiter.reject(error);
        },
      );
    }
  }
  get size(): number {
    return this.slots.length;
  }
}
export interface ResourceLease<T> {
  value: T;
  release(): void;
  invalidate(): void;
}

export async function boundedMap<T>(
  items: T[],
  limit: number,
  work: (value: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let failed: unknown;
  const worker = async () => {
    while (next < items.length && !failed && !signal?.aborted) {
      const index = next++;
      try {
        await work(items[index]!, index);
      } catch (error) {
        failed ??= error;
      }
      if (index % 8 === 7)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, worker),
  );
  if (signal?.aborted) throw new Error('操作已取消');
  if (failed) throw failed;
}

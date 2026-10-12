import { describe, expect, it, vi } from 'vitest';
import { boundedMap, ResourcePool } from '../src/resource-pool';
import { RecognitionCache } from '../src/recognition-cache';

describe('有界资源与识别缓存', () => {
  it('两个资源独立占用，释放一个立即补位且复用资源', async () => {
    let count = 0;
    const pool = new ResourcePool(2, async () => ++count, vi.fn());
    const a = await pool.acquire();
    const b = await pool.acquire();
    let acquired = false;
    const pending = pool.acquire().then((c) => {
      acquired = true;
      return c;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    b.release();
    const c = await pending;
    expect(c.value).toBe(b.value);
    expect(count).toBe(2);
    a.release();
    c.release();
  });
  it('取消排队者不消耗名额，不影响另一个任务', async () => {
    const pool = new ResourcePool(1, async () => 1, vi.fn());
    const a = await pool.acquire();
    const controller = new AbortController();
    const p = pool.acquire(controller.signal);
    controller.abort();
    await expect(p).rejects.toThrow('取消');
    a.release();
    const b = await pool.acquire();
    expect(b.value).toBe(1);
    b.release();
  });
  it('持续补位：第一个仍阻塞时第六个已开始，支持超过128个项目', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const pending = boundedMap(
      Array.from({ length: 150 }, (_, i) => i),
      5,
      async (n) => {
        started.push(n);
        active++;
        peak = Math.max(peak, active);
        if (n === 0) await blocked;
        else await Promise.resolve();
        active--;
      },
    );
    await vi.waitFor(() => expect(started).toContain(5));
    expect(started[0]).toBe(0);
    release();
    await pending;
    expect(started).toHaveLength(150);
    expect(peak).toBeLessThanOrEqual(5);
  });
  it('只缓存已确认文字，按LRU及字节预算淘汰，单题失效不影响其他题', () => {
    const cache = new RecognitionCache(500);
    cache.set('fail', '未确认', { attempts: [] }, 'a');
    expect(cache.size).toBe(0);
    cache.set('a', '甲', { source: 'ocr', attempts: [] }, 'q1');
    cache.set('b', '乙', { source: 'vision', attempts: [] }, 'q2');
    cache.invalidate('q1');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.text).toBe('乙');
    for (let i = 0; i < 20; i++)
      cache.set(
        String(i),
        'x'.repeat(80),
        { source: 'ocr', attempts: [] },
        'q',
      );
    expect(cache.usedBytes).toBeLessThanOrEqual(500);
  });
});

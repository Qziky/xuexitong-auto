import type { RecognitionTrace, RecognitionAttempt } from './domain';
export class RecognitionCacheHit extends Error {
  constructor(public attempt: RecognitionAttempt) {
    super('已确认的识别缓存');
  }
}
const CACHE_VERSION = 5;
export const SESSION_CACHE_BUDGET = 6 * 1024 * 1024;
export class RecognitionCache {
  private entries = new Map<
    string,
    { text: string; trace: RecognitionTrace; tag: string; bytes: number }
  >();
  private bytes = 0;
  constructor(private budget = SESSION_CACHE_BUDGET) {}
  get(key: string) {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return structuredClone(value);
  }
  set(key: string, text: string, trace: RecognitionTrace, tag: string): void {
    if (!trace.source) return;
    const value = { text, trace: structuredClone(trace), tag, bytes: 0 };
    value.bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (value.bytes > this.budget) return;
    this.remove(key);
    this.entries.set(key, value);
    this.bytes += value.bytes;
    while (this.bytes > this.budget)
      this.remove(this.entries.keys().next().value!);
  }
  invalidate(tag: string): void {
    for (const [key, value] of this.entries)
      if (value.tag === tag) this.remove(key);
  }
  private remove(key: string): void {
    const old = this.entries.get(key);
    if (old) this.bytes -= old.bytes;
    this.entries.delete(key);
  }
  get size(): number {
    return this.entries.size;
  }
  get usedBytes(): number {
    return this.bytes;
  }
  snapshot() {
    return { version: CACHE_VERSION, entries: [...this.entries] };
  }
  restore(value: unknown): void {
    const saved = value as ReturnType<RecognitionCache['snapshot']>;
    if (saved?.version !== CACHE_VERSION || !Array.isArray(saved.entries))
      return;
    for (const [key, entry] of saved.entries)
      if (entry?.trace?.source && typeof entry.text === 'string')
        this.set(key, entry.text, entry.trace, entry.tag);
  }
}
export const recognitionCache = new RecognitionCache(3 * 1024 * 1024);
export async function contentDigest(
  value: string | ArrayBuffer,
): Promise<string> {
  const bytes =
    typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
let loaded: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function loadRecognitionCache(): Promise<void> {
  return (loaded ??= (async () => {
    if (typeof chrome !== 'undefined' && chrome.storage?.session) {
      const saved = await chrome.storage.session
        .get('recognitionCache')
        .catch(() => ({}));
      recognitionCache.restore(
        (saved as Record<string, unknown>).recognitionCache,
      );
    }
  })());
}
export async function flushRecognitionCache(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  if (typeof chrome !== 'undefined' && chrome.storage?.session)
    await chrome.storage.session
      .set({ recognitionCache: recognitionCache.snapshot() })
      .catch(() => {});
}
export function scheduleRecognitionCacheSave(): void {
  if (!saveTimer)
    saveTimer = setTimeout(() => {
      void flushRecognitionCache();
    }, 1000);
}

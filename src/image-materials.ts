import type { ImageMaterialRef, PageSnapshot, QuestionImage } from './domain';
import { contentDigest } from './recognition-cache';

export const IMAGE_MATERIAL_BUDGET = 64 * 1024 * 1024;
export const IMAGE_MATERIAL_TTL = 7 * 24 * 60 * 60 * 1000;
interface StoredMaterial {
  ref: ImageMaterialRef;
  blob: Blob;
  touchedAt: number;
  expiresAt: number;
}
const MISSING = '题目原图材料已失效，请重新识别本题';
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(new Error('读取本机图片材料失败'));
  });
}
function complete(transaction: IDBTransaction): Promise<void> {
  const result = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(new Error('本机图片材料保存失败，请检查浏览器存储空间'));
  });
  // A request may fail before its caller reaches await done.
  void result.catch(() => {});
  return result;
}

/** Original raster bytes stay in a bounded local store, never in app/log payloads. */
export class ImageMaterialStore {
  private database?: Promise<IDBDatabase>;
  constructor(
    private readonly name = 'question-image-materials',
    private readonly budget = IMAGE_MATERIAL_BUDGET,
    private readonly now = Date.now,
  ) {}
  private open(): Promise<IDBDatabase> {
    return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('浏览器不支持本机图片材料存储'));
        return;
      }
      const opening = indexedDB.open(this.name, 1);
      opening.onupgradeneeded = () => {
        opening.result.createObjectStore('images', { keyPath: 'ref.id' });
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(new Error('无法打开本机图片材料存储'));
    }).catch((error) => {
      this.database = undefined;
      throw error;
    }));
  }
  async save(
    blob: Blob,
    page: Pick<PageSnapshot, 'accountId' | 'taskKey' | 'fingerprint'>,
    image: Pick<QuestionImage, 'id' | 'resourceKey'>,
    dimensions: { width: number; height: number },
  ): Promise<ImageMaterialRef> {
    if (
      !/^image\/(png|jpeg|webp)$/.test(blob.type) ||
      !blob.size ||
      blob.size > Math.min(this.budget, 6000000)
    )
      throw new Error('原图大小或格式超出本机图片材料限制');
    const digest = await contentDigest(await blob.arrayBuffer());
    const accountId = page.accountId ?? '';
    const id = await contentDigest(
      JSON.stringify([
        accountId,
        page.taskKey,
        page.fingerprint,
        image.id,
        image.resourceKey,
        digest,
      ]),
    );
    const ref: ImageMaterialRef = {
      id,
      digest,
      accountId,
      taskKey: page.taskKey,
      fingerprint: page.fingerprint,
      imageId: image.id,
      mimeType: blob.type,
      byteLength: blob.size,
      width: dimensions.width,
      height: dimensions.height,
    };
    const database = await this.open();
    const transaction = database.transaction('images', 'readwrite');
    const done = complete(transaction);
    const store = transaction.objectStore('images');
    const existing = await request<StoredMaterial[]>(store.getAll());
    const now = this.now();
    let bytes = blob.size;
    const retained = existing.filter((entry) => entry.ref.id !== id);
    for (const entry of retained) {
      if (entry.expiresAt <= now) store.delete(entry.ref.id);
      else bytes += entry.ref.byteLength;
    }
    for (const entry of retained
      .filter((entry) => entry.expiresAt > now)
      .sort((a, b) => a.touchedAt - b.touchedAt)) {
      if (bytes <= this.budget) break;
      store.delete(entry.ref.id);
      bytes -= entry.ref.byteLength;
    }
    store.put({
      ref,
      blob,
      touchedAt: now,
      expiresAt: now + IMAGE_MATERIAL_TTL,
    });
    await done;
    return ref;
  }
  async read(ref: ImageMaterialRef): Promise<Blob> {
    const database = await this.open();
    const transaction = database.transaction('images', 'readwrite');
    const done = complete(transaction);
    const store = transaction.objectStore('images');
    const saved = await request<StoredMaterial | undefined>(store.get(ref.id));
    if (!saved || saved.expiresAt <= this.now()) {
      if (saved) store.delete(ref.id);
      await done;
      throw new Error(MISSING);
    }
    if (
      Object.keys(saved.ref).some(
        (key) =>
          saved.ref[key as keyof ImageMaterialRef] !==
          ref[key as keyof ImageMaterialRef],
      ) ||
      saved.blob.type !== ref.mimeType ||
      saved.blob.size !== ref.byteLength
    ) {
      await done;
      throw new Error(MISSING);
    }
    saved.touchedAt = this.now();
    store.put(saved);
    await done;
    return saved.blob;
  }
  async clear(): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction('images', 'readwrite');
    const done = complete(transaction);
    transaction.objectStore('images').clear();
    await done;
  }
}
export const imageMaterials = new ImageMaterialStore();

export async function materialDataUrl(
  ref: ImageMaterialRef,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DOMException('图片作答已取消', 'AbortError');
  const blob = await imageMaterials.read(ref);
  if (signal?.aborted) throw new DOMException('图片作答已取消', 'AbortError');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) {
    if (signal?.aborted) throw new DOMException('图片作答已取消', 'AbortError');
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  }
  return `data:${blob.type};base64,${btoa(chunks.join(''))}`;
}

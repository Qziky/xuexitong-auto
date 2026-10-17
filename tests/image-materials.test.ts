import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ImageMaterialStore, IMAGE_MATERIAL_TTL } from '../src/image-materials';
import { stripImageResources } from '../src/image-content';
import type { PageSnapshot } from '../src/domain';

const blob = () =>
  new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
    type: 'image/png',
  });
const page = {
  accountId: 'account-a',
  taskKey: 'course:class:task',
  fingerprint: 'page-a',
};
const dimensions = { width: 10, height: 10 };
let index = 0;
beforeEach(() => vi.stubGlobal('Blob', NativeBlob));
afterEach(() => vi.unstubAllGlobals());
function setup(budget = 64) {
  const name = 'material-test-' + ++index;
  let now = Date.now();
  return {
    store: new ImageMaterialStore(name, budget, () => now),
    name,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('本机题目原图材料', () => {
  it('保存原始字节，跨存储实例读取；相同材料不会重复占用容量', async () => {
    const { store, name } = setup(8);
    const ref = await store.save(
      blob(),
      page,
      { id: 'i1', resourceKey: 'r1' },
      dimensions,
    );
    const repeated = await store.save(
      blob(),
      page,
      { id: 'i1', resourceKey: 'r1' },
      dimensions,
    );
    expect(repeated).toEqual(ref);
    const restored = await new ImageMaterialStore(name, 8).read(ref);
    expect(new Uint8Array(await restored.arrayBuffer())).toEqual(
      new Uint8Array(await blob().arrayBuffer()),
    );
  });
  it('账号、任务、页面和图片的归属参与材料身份，篡改引用不可读取', async () => {
    const { store } = setup();
    const ref = await store.save(
      blob(),
      page,
      { id: 'i1', resourceKey: 'r1' },
      dimensions,
    );
    const other = await store.save(
      blob(),
      { ...page, accountId: 'account-b' },
      { id: 'i1', resourceKey: 'r1' },
      dimensions,
    );
    expect(other.id).not.toBe(ref.id);
    for (const change of [
      { accountId: 'account-b' },
      { taskKey: 'other' },
      { fingerprint: 'other' },
      { imageId: 'i2' },
    ])
      await expect(store.read({ ...ref, ...change })).rejects.toThrow('已失效');
  });
  it('容量不足时淘汰最近最少读取的材料', async () => {
    const { store, advance } = setup(16);
    const a = await store.save(
      blob(),
      page,
      { id: 'a', resourceKey: 'a' },
      dimensions,
    );
    advance(1);
    const b = await store.save(
      blob(),
      page,
      { id: 'b', resourceKey: 'b' },
      dimensions,
    );
    advance(1);
    await store.read(a);
    advance(1);
    const c = await store.save(
      blob(),
      page,
      { id: 'c', resourceKey: 'c' },
      dimensions,
    );
    await expect(store.read(b)).rejects.toThrow('已失效');
    expect((await store.read(a)).size).toBe(8);
    expect((await store.read(c)).size).toBe(8);
  });
  it('七天到期或清除后，必须重新读取原图', async () => {
    const { store, advance } = setup();
    const a = await store.save(
      blob(),
      page,
      { id: 'a', resourceKey: 'a' },
      dimensions,
    );
    advance(IMAGE_MATERIAL_TTL);
    await expect(store.read(a)).rejects.toThrow('已失效');
    const b = await store.save(
      blob(),
      page,
      { id: 'b', resourceKey: 'b' },
      dimensions,
    );
    await store.clear();
    await expect(store.read(b)).rejects.toThrow('已失效');
  });
  it('拒绝超出容量、SVG 和空材料', async () => {
    const { store } = setup(7);
    await expect(
      store.save(blob(), page, { id: 'a', resourceKey: 'a' }, dimensions),
    ).rejects.toThrow('限制');
    await expect(
      store.save(
        new Blob(['<svg/>'], { type: 'image/svg+xml' }),
        page,
        { id: 'a', resourceKey: 'a' },
        dimensions,
      ),
    ).rejects.toThrow('限制');
  });
  it('快照仅保留引用，资源地址清理后仍可找到原图，不包含图片负载', async () => {
    const { store } = setup();
    const ref = await store.save(
      blob(),
      page,
      { id: 'i1', resourceKey: 'r1' },
      dimensions,
    );
    const snapshot = {
      questions: [
        {
          images: [
            {
              id: 'i1',
              src: 'https://mooc1.chaoxing.com/image?token=private',
              material: ref,
            },
          ],
        },
      ],
    } as PageSnapshot;
    stripImageResources(snapshot);
    expect(snapshot.questions[0]!.images![0]!.src).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toMatch(/base64|data:image|private/);
    expect(
      (await store.read(snapshot.questions[0]!.images![0]!.material!)).size,
    ).toBe(8);
  });
});

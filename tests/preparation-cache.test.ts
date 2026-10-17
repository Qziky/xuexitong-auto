import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ImageMaterialStore, IMAGE_MATERIAL_TTL } from '../src/image-materials';
import { reusableQuestionIds } from '../src/preparation-cache';
import type { PageSnapshot, QuestionRecord } from '../src/domain';

let index = 0;
beforeEach(() => vi.stubGlobal('Blob', NativeBlob));
afterEach(() => vi.unstubAllGlobals());

function setup(budget = 64) {
  let now = Date.now();
  const store = new ImageMaterialStore(
    'preparation-cache-' + ++index,
    budget,
    () => now,
  );
  const question: QuestionRecord = {
    id: 'q1',
    number: 1,
    type: 'single',
    stem: '文字题',
    required: true,
    options: [{ id: 'a', key: 'A', label: 'A', text: '答案' }],
    existing: [],
    blanks: [],
    issues: [],
  };
  const page: PageSnapshot = {
    accountId: 'account-a',
    taskKey: 'course:class:task',
    fingerprint: 'page-a',
    adapter: 'modern',
    url: 'https://mooc1.chaoxing.com/work',
    title: '测试',
    status: 'pending',
    questions: [question],
  };
  const addImage = async (id = 'q1', number = 1) => {
    const q: QuestionRecord = {
      ...structuredClone(question),
      id,
      number,
      stem: '题目〔图片1〕',
    };
    const image = {
      id: id + ':image1',
      part: 'stem' as const,
      placeholder: '〔图片1〕',
      resourceKey: 'formula',
    };
    const material = await store.save(
      new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
        type: 'image/png',
      }),
      page,
      image,
      { width: 1, height: 1 },
    );
    q.images = [{ ...image, material }];
    q.recognition = { stem: { source: 'image', attempts: [] }, options: {} };
    page.questions = [...page.questions.filter((old) => old.id !== id), q];
    return q;
  };
  return {
    store,
    page,
    addImage,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('识别结果与原图缓存的一致性', () => {
  it('原图到期后失效的是对应图片题，纯文字题继续复用', async () => {
    const { store, page, addImage, advance } = setup();
    await addImage('q2', 2);
    expect(await reusableQuestionIds(page, undefined, store)).toEqual(
      new Set(['q1', 'q2']),
    );
    advance(IMAGE_MATERIAL_TTL);
    expect(await reusableQuestionIds(page, undefined, store)).toEqual(
      new Set(['q1']),
    );
  });
  it('容量淘汰或清空原图后，旧会话中的有效引用也不能当作可用材料', async () => {
    const { store, page, addImage, advance } = setup(8);
    await addImage('q2', 2);
    advance(1);
    await addImage('q3', 3);
    expect(await reusableQuestionIds(page, undefined, store)).toEqual(
      new Set(['q1', 'q3']),
    );
    await store.clear();
    expect(await reusableQuestionIds(page, undefined, store)).toEqual(
      new Set(['q1']),
    );
  });
  it('图片失败或缺少材料引用时不保留，即使旧记录漏记了错误', async () => {
    const { store, page, addImage } = setup();
    const q = await addImage();
    q.issues = ['图片读取失败'];
    expect(await reusableQuestionIds(page, undefined, store)).toEqual(
      new Set(),
    );
    q.issues = [];
    delete q.images![0]!.material;
    expect(await reusableQuestionIds(page, undefined, store)).toEqual(
      new Set(),
    );
  });
  it.each(['accountId', 'taskKey', 'fingerprint', 'imageId'] as const)(
    '不复用与当前题目 %s 不匹配的原图',
    async (field) => {
      const { store, page, addImage } = setup();
      const q = await addImage();
      q.images![0]!.material![field] = 'other';
      expect(await reusableQuestionIds(page, undefined, store)).toEqual(
        new Set(),
      );
    },
  );
  it('已完整转成公式文字的题目不依赖过期原图', async () => {
    const { store, page, addImage, advance } = setup();
    const q = await addImage();
    q.stem = '题目 $x^2$';
    q.recognition!.stem.source = 'vision';
    advance(IMAGE_MATERIAL_TTL);
    expect(await reusableQuestionIds(page, undefined, store)).toEqual(
      new Set(['q1']),
    );
  });
  it('缓存检查取消后不返回可复用的结果', async () => {
    const { store, page, addImage } = setup();
    await addImage();
    const controller = new AbortController();
    await expect(
      reusableQuestionIds(page, controller.signal, {
        read: async (ref) => {
          controller.abort();
          return store.read(ref);
        },
      }),
    ).rejects.toThrow('取消');
  });
});

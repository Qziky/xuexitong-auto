import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { extractPage } from '../src/page-parser';
import { readPageImageResource } from '../src/page-image';
import { PlatformAccessError } from '../src/platform-access';

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const url =
  'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/dowork?courseId=100&classId=200&workId=900';
function fixture() {
  const page = extractPage(
    new DOMParser().parseFromString(
      '<div class="questionLi" id="question10"><h3 class="mark_name">题干<img src="https://p.cldisk.com/star3/origin/formula.png"></h3></div>',
      'text/html',
    ),
    url,
  )!;
  page.accountId = 'cx:1';
  const binding = {
    accountId: page.accountId,
    taskKey: page.taskKey,
    fingerprint: page.fingerprint,
  };
  return { page, binding, image: page.questions[0]!.images![0]! };
}
beforeEach(() => {
  vi.stubGlobal('Blob', NativeBlob);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(bytes, { headers: { 'Content-Type': 'image/png' } }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

it('课程页面读取原始 PNG 字节，不携带登录凭据、不重建图片', async () => {
  const { page, binding, image } = fixture();
  const result = await readPageImageResource(
    page,
    binding,
    image.id,
    image.resourceKey,
  );
  expect(result).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(fetch).toHaveBeenCalledWith(
    image.src,
    expect.objectContaining({ credentials: 'omit', redirect: 'follow' }),
  );
  expect(image.src).toBe('https://p.cldisk.com/star3/origin/formula.png');
});
it('旧 HTTP cldisk 题图仍由绑定的课程页面读取，实际请求为 HTTPS', async () => {
  const { page, binding, image } = fixture();
  image.src = 'http://p.cldisk.com/star3/origin/formula.png';
  expect(
    await readPageImageResource(page, binding, image.id, image.resourceKey),
  ).toBe('data:image/png;base64,iVBORw0KGgo=');
  expect(fetch).toHaveBeenCalledWith(
    'https://p.cldisk.com/star3/origin/formula.png',
    expect.objectContaining({ credentials: 'omit', redirect: 'follow' }),
  );
});
it.each(['accountId', 'taskKey', 'fingerprint'] as const)(
  '%s 变化后不读取任何原图',
  async (field) => {
    const { page, binding, image } = fixture();
    await expect(
      readPageImageResource(
        page,
        { ...binding, [field]: 'changed' },
        image.id,
        image.resourceKey,
      ),
    ).rejects.toThrow('已变化');
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('拒绝不在当前题目中的图片、替换后的原图和其他来源', async () => {
  const { page, binding, image } = fixture();
  await expect(
    readPageImageResource(page, binding, 'other', image.resourceKey),
  ).rejects.toThrow('不属于');
  await expect(
    readPageImageResource(page, binding, image.id, 'changed'),
  ).rejects.toThrow('不属于');
  image.src = 'https://example.test/private.png';
  await expect(
    readPageImageResource(page, binding, image.id, image.resourceKey),
  ).rejects.toThrow('不属于');
  expect(fetch).not.toHaveBeenCalled();
});
it('只读预览页也能读取题图，不借用写入授权', async () => {
  const { page, binding, image } = fixture();
  page.status = 'submitted';
  page.pageMode = 'preview';
  expect(
    await readPageImageResource(page, binding, image.id, image.resourceKey),
  ).toContain('data:image/png');
});
it('图片限流直接上报平台暂停，不重试', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 429 }));
  const { page, binding, image } = fixture();
  await expect(
    readPageImageResource(page, binding, image.id, image.resourceKey),
  ).rejects.toBeInstanceOf(PlatformAccessError);
  expect(fetch).toHaveBeenCalledOnce();
});

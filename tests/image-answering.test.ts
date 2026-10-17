import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER, type QuestionRecord } from '../src/domain';
import { imageMaterials } from '../src/image-materials';
import { solveBatch } from '../src/provider';

const textProvider = {
  ...DEFAULT_PROVIDER,
  baseUrl: 'https://text.example.test/v1',
  model: 'text-model',
  apiKey: 'text-placeholder',
};
const visionProvider = {
  ...DEFAULT_PROVIDER,
  baseUrl: 'https://vision.example.test/v1',
  model: 'vision-model',
  apiKey: 'vision-placeholder',
};
const png = () =>
  new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
    type: 'image/png',
  });
let fetcher: ReturnType<typeof vi.fn>;
const ok = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
function answer(questions: QuestionRecord[]) {
  return JSON.stringify({
    answers: questions.map((q) => ({
      questionId: q.id,
      optionIds: [q.options[0]!.id],
      explanation: '依据图像与文字',
      needsReview: false,
    })),
  });
}
async function question(
  id: string,
  part: 'stem' | 'option',
): Promise<QuestionRecord> {
  const imageId = id + ':image1';
  const material = await imageMaterials.save(
    png(),
    {
      accountId: 'private-account',
      taskKey: 'private-task',
      fingerprint: 'private-page',
    },
    { id: imageId, resourceKey: 'private-resource' },
    { width: 10, height: 10 },
  );
  return {
    id,
    number: Number(id),
    type: 'single',
    required: true,
    issues: [],
    existing: [],
    blanks: [],
    stem:
      part === 'stem'
        ? '观察〔图片1〕并选择正确描述。'
        : '根据文字描述选择对应图形。',
    options: [
      {
        id: id + ':o1',
        key: 'D',
        label: 'A',
        text: part === 'option' ? '〔图片1〕' : '递增',
      },
      { id: id + ':o2', key: 'A', label: 'B', text: '其他' },
    ],
    images: [
      {
        id: imageId,
        part,
        ...(part === 'option' ? { optionId: id + ':o1' } : {}),
        placeholder: '〔图片1〕',
        resourceKey: 'private-resource',
        material,
      },
    ],
    recognition: {
      stem: { source: part === 'stem' ? 'image' : 'web', attempts: [] },
      options: {
        [id + ':o1']: {
          source: part === 'option' ? 'image' : 'web',
          attempts: [],
        },
      },
    },
  };
}
beforeEach(async () => {
  vi.stubGlobal('Blob', NativeBlob);
  await imageMaterials.clear();
  fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('已有原图与文字共同作答', () => {
  it('复用本机题干和选项图片，携带精确对应关系，不把账号或平台地址发给模型', async () => {
    const questions = [
      await question('1', 'stem'),
      await question('2', 'option'),
    ];
    fetcher.mockResolvedValue(ok(answer(questions)));
    const result = await solveBatch(
      textProvider,
      structuredClone(questions),
      'overwrite',
      undefined,
      undefined,
      0,
      visionProvider,
    );
    expect(result.map((a) => a.optionIds)).toEqual([['1:o1'], ['2:o1']]);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://vision.example.test/v1/chat/completions');
    const body = JSON.parse(request.body);
    expect(body.model).toBe('vision-model');
    const parts = body.messages[1].content;
    expect(
      parts
        .filter((p: any) => p.type === 'image_url')
        .map((p: any) => p.image_url.url),
    ).toEqual([
      'data:image/png;base64,iVBORw0KGgo=',
      'data:image/png;base64,iVBORw0KGgo=',
    ]);
    expect(JSON.parse(parts[1].text)).toMatchObject({
      questionId: '1',
      imageId: '1:image1',
      part: 'stem',
      placeholder: '〔图片1〕',
    });
    expect(JSON.parse(parts[3].text)).toMatchObject({
      questionId: '2',
      imageId: '2:image1',
      part: 'option',
      optionId: '2:o1',
    });
    expect(request.body).not.toMatch(
      /private-account|private-task|private-page|private-resource|"key"|chaoxing\.com/,
    );
    expect(request.credentials).toBe('omit');
    expect(request.redirect).toBe('error');
  });
  it('纯文字题继续使用答题模型，不读取或发送原图', async () => {
    const q = await question('1', 'stem');
    q.stem = '普通文字';
    fetcher.mockResolvedValue(ok(answer([q])));
    const read = vi.spyOn(imageMaterials, 'read');
    await solveBatch(
      textProvider,
      [q],
      'preserve',
      undefined,
      undefined,
      0,
      visionProvider,
    );
    expect(fetcher.mock.calls[0]![0]).toBe(
      'https://text.example.test/v1/chat/completions',
    );
    expect(
      typeof JSON.parse(fetcher.mock.calls[0]![1].body).messages[1].content,
    ).toBe('string');
    expect(read).not.toHaveBeenCalled();
  });
  it('原图丢失或未保存时不会仅凭占位文字请求模型', async () => {
    const q = await question('1', 'stem');
    await imageMaterials.clear();
    await expect(
      solveBatch(
        textProvider,
        [q],
        'overwrite',
        undefined,
        undefined,
        0,
        visionProvider,
      ),
    ).rejects.toThrow('原图材料已失效');
    q.images![0]!.material = undefined;
    await expect(solveBatch(textProvider, [q], 'overwrite')).rejects.toThrow(
      '原图材料缺失',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('格式修复继续提供同一组原图和文字材料，最多修复一次', async () => {
    const q = await question('1', 'stem');
    fetcher
      .mockResolvedValueOnce(ok('bad-json'))
      .mockResolvedValueOnce(ok(answer([q])));
    const read = vi.spyOn(imageMaterials, 'read');
    await solveBatch(
      textProvider,
      [q],
      'overwrite',
      undefined,
      undefined,
      0,
      visionProvider,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    const bodies = fetcher.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[1].messages[1]).toEqual(bodies[0].messages[1]);
    expect(read).toHaveBeenCalledOnce();
  });
  it('不支持图片的模型明确报错，不降为只有占位符的文字请求', async () => {
    const q = await question('1', 'stem');
    fetcher.mockResolvedValue(
      new Response('model does not support image input', { status: 400 }),
    );
    await expect(
      solveBatch(
        textProvider,
        [q],
        'overwrite',
        undefined,
        undefined,
        0,
        visionProvider,
      ),
    ).rejects.toMatchObject({ code: 'image-unsupported' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('取消或视觉服务没有密钥时，不派发图片作答请求', async () => {
    const q = await question('1', 'stem');
    const cancel = new AbortController();
    cancel.abort();
    await expect(
      solveBatch(textProvider, [q], 'overwrite', cancel.signal),
    ).rejects.toThrow('取消');
    await expect(
      solveBatch(textProvider, [q], 'overwrite', undefined, undefined, 0, {
        ...visionProvider,
        apiKey: '',
      }),
    ).rejects.toThrow('视觉模型');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

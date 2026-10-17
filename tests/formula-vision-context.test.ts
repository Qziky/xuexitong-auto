import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER } from '../src/domain';
import { transcribeSegments, resetVisionCapability } from '../src/vision';

const provider = { ...DEFAULT_PROVIDER, apiKey: 'formula-context-placeholder' };
afterEach(() => {
  resetVisionCapability(provider);
  vi.unstubAllGlobals();
});

it('转录请求逐字区分变量，并传递上下文而不擅自清除模型的不确定标记', async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                segments: [
                  {
                    id: 'option-c',
                    kind: 'formula',
                    text: String.raw`\(y=t-7\)`,
                    needsReview: true,
                  },
                ],
              }),
            },
          },
        ],
      }),
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const context = JSON.stringify({
    stem: String.raw`与\(y=x-7\)相同的是`,
    part: 'option',
    optionLabel: 'C',
  });
  const result = await transcribeSegments(provider, [
    {
      id: 'option-c',
      originalImage: true,
      image: 'data:image/png;base64,AAAA',
      context,
    },
  ]);
  const body = JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(body.messages[0].content).toContain('x/2、y/v、t/i');
  expect(body.messages[0].content).toContain('不能统一替换变量');
  expect(body.messages[1].content[0].text).toContain(context);
  expect(result.get('option-c')).toMatchObject({
    success: false,
    reason: '视觉模型表示文字无法可靠确认',
  });
});

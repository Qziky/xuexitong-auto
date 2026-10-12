import { describe, expect, it } from 'vitest';
import {
  classifyTaskPage,
  matchesTaskFrameKey,
  taskIdentifiers,
} from '../src/task-context';

const PATH = 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew';
const CHAPTER = `${PATH}?courseId=100&classId=200&workId=900&api=1&knowledgeid=300`;

describe('真实章节新版答题入口', () => {
  it.each(['selectWorkQuestionYiPiYue', 'selectWorkQuestionWeiPiYue'])(
    '旧版已提交入口 %s 保持章节与普通作业上下文分类',
    (endpoint) => {
      const reviewed = CHAPTER.replace('doHomeWorkNew', endpoint);
      expect(classifyTaskPage(reviewed, '', '查看已批阅作业')).toBe('quiz');
      expect(
        classifyTaskPage(
          reviewed.split('?')[0] + '?workId=900',
          '',
          '查看作业',
        ),
      ).toBe('homework');
      expect(classifyTaskPage(reviewed, '', '期末考试')).toBe('exam');
    },
  );
  it('作业预览入口正确登记为普通作业，考试仍优先拦截', () => {
    const preview =
      'https://mooc1.chaoxing.com/mooc-ans/mooc2/work/preview?workId=900';
    expect(classifyTaskPage(preview, '', '作业详情')).toBe('homework');
    expect(classifyTaskPage(preview, '', '期末考试')).toBe('exam');
  });
  it('章节任务模块中的 doHomeWorkNew 识别为测验', () => {
    expect(
      classifyTaskPage(
        CHAPTER,
        'https://mooc1.chaoxing.com/ananas/modules/work/index.html',
        '做作业',
      ),
    ).toBe('quiz');
    expect(taskIdentifiers(CHAPTER)).toEqual({
      course: '100',
      clazz: '200',
      work: '900',
    });
  });
  it('使用 oldWorkId 将卡片任务绑定到其数字作业实例', () => {
    const stableId = '0123456789abcdef0123456789abcdef';
    const url = `${CHAPTER}&oldWorkId=${stableId}`;
    const expected = `100:200:work:${stableId}`;
    expect(
      matchesTaskFrameKey({
        url,
        taskKey: '100:200:work:900',
      }, expected),
    ).toBe(true);
    expect(
      matchesTaskFrameKey(
        { url: url.replace('oldWorkId=', 'oldWorkId=wrong'), taskKey: '100:200:work:900' },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesTaskFrameKey(
        { url: url.replace('courseId=100', 'courseId=999'), taskKey: '999:200:work:900' },
        expected,
      ),
    ).toBe(false);
  });
  it('提交后的复核页使用同一任务已读回的实例编号继续核验', () => {
    const stableId = '0123456789abcdef0123456789abcdef';
    const expected = `100:200:work:${stableId}`;
    expect(
      matchesTaskFrameKey(
        {
          url: `${PATH}?courseId=100&classId=200&workId=900`,
          taskKey: '100:200:work:900',
        },
        expected,
        '100:200:work:900',
      ),
    ).toBe(true);
    expect(
      matchesTaskFrameKey(
        {
          url: `${PATH}?courseId=999&classId=200&workId=901`,
          taskKey: '999:200:work:901',
        },
        expected,
        '999:200:work:901',
      ),
    ).toBe(false);
  });
  it('直接打开已登记测验或 referrer 被浏览器缩短时，仍依据章节上下文识别', () => {
    expect(classifyTaskPage(CHAPTER, '', '做作业')).toBe('quiz');
    expect(
      classifyTaskPage(CHAPTER, 'https://mooc1.chaoxing.com/', '做作业'),
    ).toBe('quiz');
  });
  it('普通作业与缺失或无效章节标识不冒充章节测验', () => {
    expect(classifyTaskPage(`${PATH}?workId=900`, '', '做作业')).toBe(
      'homework',
    );
    expect(classifyTaskPage(`${PATH}?workId=900&api=1`, '', '做作业')).toBe(
      'homework',
    );
    expect(classifyTaskPage(`${PATH}?workId=900&api=1&knowledgeid=0`)).toBe(
      'homework',
    );
    expect(
      classifyTaskPage(`${PATH}?workId=900&api=1&knowledgeid=invalid`),
    ).toBe('homework');
  });
  it('考试上下文始终优先，只有新版 work 路径扩展识别范围', () => {
    expect(classifyTaskPage(CHAPTER, '', '期末考试')).toBe('exam');
    expect(
      classifyTaskPage(
        CHAPTER,
        'https://mooc1.chaoxing.com/exam-ans/exam/test',
      ),
    ).toBe('exam');
    expect(
      classifyTaskPage(
        'https://mooc1.chaoxing.com/unknown?api=1&knowledgeid=300',
      ),
    ).toBeUndefined();
  });
});

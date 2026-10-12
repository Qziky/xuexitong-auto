import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { learningMenu, parseLearningCards } from '../src/learning-parser';
import { inertDocument } from '../src/scan-parser';
import { allowedPlatformRead } from '../src/platform-reader';
import { VideoPlayer } from '../src/video-player';
import { SerialChannel } from '../src/serial-channel';
import { initialState, type CourseRecord } from '../src/domain';
const course = {
  id: '100:200',
  accountId: 'cx:1',
  courseId: '100',
  classId: '200',
} as CourseRecord;
const url =
  'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?courseid=100&clazzid=200&knowledgeid=300';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('新鲜服务器记录中已知阅读任务的 job=false 是完成证据，普通资源和其他任务不推断完成', () => {
  const doc = inertDocument(
    '<script>var mArg={"attachments":[{"type":"document","jobid":"d01","job":false,"property":{"objectid":"doc1"}}]}</script>',
  );
  expect(
    parseLearningCards(doc, url, course, '300', { fresh: true }),
  ).toHaveLength(0);
  expect(
    parseLearningCards(doc, url, course, '300', {
      fresh: true,
      knownReadingTask: { jobId: 'd01', objectId: 'wrong' },
    }),
  ).toHaveLength(0);
  expect(
    parseLearningCards(doc, url, course, '300', {
      fresh: false,
      knownReadingTask: { jobId: 'd01', objectId: 'doc1' },
    }),
  ).toHaveLength(0);
  const verified = parseLearningCards(doc, url, course, '300', {
    fresh: true,
    knownReadingTask: { jobId: 'd01', objectId: 'doc1' },
  });
  expect(verified[0]).toMatchObject({
    platformComplete: true,
    completionEvidence: { fresh: true, source: 'configuration' },
  });
  doc.querySelector('script')!.textContent =
    'var mArg={"attachments":[{"type":"document","jobid":"d01","job":false,"isPassed":false,"property":{"objectid":"doc1"}}]}';
  expect(
    parseLearningCards(doc, url, course, '300', {
      fresh: true,
      knownReadingTask: { jobId: 'd01', objectId: 'doc1' },
    })[0]?.platformComplete,
  ).toBe(false);
});
it('只有明确的学习读取目的允许卡片；课程自动刷新目的仍拒绝', () => {
  expect(allowedPlatformRead(url, 'learning')).toBe(true);
  expect(allowedPlatformRead(url, 'catalog')).toBe(false);
  expect(allowedPlatformRead(url, 'navigation')).toBe(false);
  expect(allowedPlatformRead(url, 'homework-list')).toBe(false);
});
it('任务数据区分视频、章节题及完成状态，不把播放器结束推断为完成', () => {
  const doc = inertDocument(readFileSync('tests/fixtures/cards.html', 'utf8'));
  const items = parseLearningCards(doc, url, course, '300');
  expect(items.map((i) => i.type)).toEqual(['video', 'quiz']);
  expect(items[0]).toMatchObject({
    jobId: 'v01',
    phase: 'waiting',
    platformComplete: false,
  });
  expect(items[1]?.task).toMatchObject({ platformId: '900', listed: false });
  doc.querySelector('script')!.textContent =
    'var mArg={"attachments":[{"type":"video","jobid":"v01","isPassed":true,"property":{"objectid":"video01"}}]}';
  expect(parseLearningCards(doc, url, course, '300')[0]?.completionState).toBe(
    'conflict',
  );
  expect(
    parseLearningCards(doc, url, course, '300', { fresh: true })[0]
      ?.platformComplete,
  ).toBe(true);
});
it('目录保留真实导航与完成依据，不从剩余数量推断章节数', () => {
  const doc = inertDocument(
    '<a id="cur300" onclick="getTeacherAjax(100,200,300)">1.2 概述</a><li><i class="icon_yiwancheng"></i><a data-knowledgeid="301" href="/knowledge/cards?knowledgeid=301">完成的章节</a></li>',
  );
  const menu = learningMenu(doc, url);
  expect(menu.chapters).toHaveLength(2);
  expect(menu.chapters[0]?.url).toBeUndefined();
  expect(menu.chapters[1]?.complete).toBe(true);
});
it('真实新版目录的 toOld 父节点与 icon_yiwanc 完成标记可以识别', () => {
  const doc = inertDocument(
    '<div class="chapter_item" id="cur300" onclick="toOld(100,200,300,0)"><div class="catalog_title" role="link"><div class="catalog_name">1.2 计算机概述</div><div class="catalog_state icon_yiwanc"><span>已完成</span></div></div></div><div class="chapter_item" id="cur301" onclick="toOld(100,200,301,0)"><div class="catalog_name">1.2.1 计算机概述</div><div class="catalog_state">1</div></div>',
  );
  const menu = learningMenu(doc, url);
  expect(menu.chapters).toHaveLength(2);
  expect(menu.chapters[0]).toMatchObject({
    id: '300',
    complete: true,
    title: '1.2 计算机概述',
  });
  expect(menu.chapters[1]).toMatchObject({ id: '301', complete: false });
});
it('答题通道只有一个活动请求，队列请求在等待的参考请求之前补位', async () => {
  const channel = new SerialChannel(),
    release = await channel.acquire();
  const order: string[] = [];
  const reference = channel.acquire(undefined, 0).then((r) => {
    order.push('reference');
    r();
  });
  const queue = channel.acquire(undefined, 1).then((r) => {
    order.push('queue');
    r();
  });
  release();
  await Promise.all([reference, queue]);
  expect(order).toEqual(['queue', 'reference']);
});
it('播放使用静音正常速度，运行绑定失效会暂停；被阻止时没有播放成功状态', async () => {
  vi.useFakeTimers();
  const doc = inertDocument('<video></video>'),
    video = doc.querySelector('video')!;
  const play = vi.fn(async () => {}),
    pause = vi.fn();
  Object.defineProperties(video, {
    play: { value: play },
    pause: { value: pause },
    duration: { value: 60 },
    currentTime: { value: 1, writable: true },
    paused: { value: false, writable: true },
    readyState: { value: 4 },
  });
  const send = vi.fn(async () => true);
  const player = new VideoPlayer(
    doc,
    () => url,
    async () => true,
    send,
  );
  const binding = {
    learningId: 'l',
    runId: 'r',
    itemId: 'i',
    accountId: 'cx:1',
  };
  await player.play(binding);
  expect(video.muted).toBe(true);
  expect(video.playbackRate).toBe(1);
  send.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(5000);
  expect(pause).toHaveBeenCalled();
  play.mockRejectedValue(new Error('NotAllowedError'));
  await expect(player.play(binding)).rejects.toThrow('阻止');
  player.pause();
});
it('旧视频事件不能更新另一项任务，也不能在重启暂停状态恢复播放', async () => {
  vi.resetModules();
  const s = initialState();
  s.accountId = 'cx:1';
  s.learning = {
    ...s.learning,
    id: 'l',
    runId: 'r',
    phase: 'running',
    accountId: 'cx:1',
    tabId: 3,
    frameId: 8,
    items: [{ id: 'i', type: 'video', phase: 'playing' } as any],
  };
  vi.doMock('../src/background/store', () => ({
    state: s,
    persist: vi.fn(),
    log: vi.fn(),
  }));
  const { authorizeVideo } = await import('../src/background/learning');
  const b = { learningId: 'l', runId: 'r', itemId: 'i', accountId: 'cx:1' };
  expect(authorizeVideo(b, 3, 8)).toBe(true);
  expect(authorizeVideo({ ...b, itemId: 'other' }, 3, 8)).toBe(false);
  s.learning.phase = 'paused';
  expect(authorizeVideo(b, 3, 8)).toBe(false);
  vi.doUnmock('../src/background/store');
});

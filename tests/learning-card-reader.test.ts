import { beforeEach, expect, it, vi } from 'vitest';
import type { CourseRecord, LearningItem } from '../src/domain';
import { PlatformAccessError } from '../src/platform-access';
import { parseLearningCards } from '../src/learning-parser';
import { inertDocument } from '../src/scan-parser';
const mocks = vi.hoisted(() => ({ read: vi.fn(), discover: vi.fn() }));
vi.mock('../src/background/transport', () => ({
  frameCall: mocks.read,
  discoverFrames: mocks.discover,
}));
import {
  loadedLearningCard,
  sameCardPage,
} from '../src/background/learning-card-reader';
const URL =
  'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?courseid=100&clazzid=200&knowledgeid=300&num=0';
const course = {
  id: '100:200',
  accountId: 'a',
  courseId: '100',
  classId: '200',
} as CourseRecord;
const item = {
  id: 'v',
  courseId: course.id,
  chapterId: '300',
  url: URL,
} as LearningItem;
const ref = {
  tabId: 10,
  frameId: 3,
  documentId: 'card-1',
  url: URL,
  top: false,
  loginRequired: false,
};
const root = {
  tabId: 10,
  frameId: 0,
  documentId: 'root',
  url: 'https://mooc1.chaoxing.com/course',
  accountId: 'a',
  loginRequired: false,
  top: true,
};
let read: any;
beforeEach(() => {
  vi.clearAllMocks();
  read = {
    html: '<div>卡片内容</div>',
    url: URL,
    info: { url: URL, loginRequired: false },
  };
  mocks.read.mockImplementation(async () => read);
  mocks.discover.mockResolvedValue([root, ref]);
});
it('reads a pinned loaded iframe without requiring an account ID on the child itself', async () => {
  const signal = new AbortController().signal;
  expect(
    await loadedLearningCard(ref, item, course, 'a', signal),
  ).toMatchObject({ html: '<div>卡片内容</div>', source: 'page' });
  expect(mocks.read).toHaveBeenCalledOnce();
  expect(mocks.read).toHaveBeenCalledWith(ref, { op: 'html' }, { signal });
});
it.each([
  URL.replace('num=0', 'num=1'),
  URL.replace('knowledgeid=300', 'knowledgeid=301'),
  URL.replace('courseid=100', 'courseid=101'),
  URL.replace('clazzid=200', 'clazzid=201'),
])('does not reuse a different card identity: %s', async (url) => {
  expect(
    await loadedLearningCard(
      { ...ref, url },
      item,
      course,
      'a',
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(mocks.read).not.toHaveBeenCalled();
});
it('invalidates a snapshot when the document changes during extraction', async () => {
  mocks.discover.mockResolvedValue([root, { ...ref, documentId: 'card-2' }]);
  expect(
    await loadedLearningCard(
      ref,
      item,
      course,
      'a',
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(mocks.read).toHaveBeenCalledOnce();
});
it('channel failure and missing document identity yield a single-fallback opportunity', async () => {
  mocks.read.mockRejectedValue(new Error('document was replaced'));
  expect(
    await loadedLearningCard(
      ref,
      item,
      course,
      'a',
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(
    await loadedLearningCard(
      { ...ref, documentId: undefined },
      item,
      course,
      'a',
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(mocks.read).toHaveBeenCalledOnce();
});
it('captcha and account changes are fatal rather than opportunities for another request', async () => {
  read.info.verificationRequired = true;
  await expect(
    loadedLearningCard(ref, item, course, 'a', new AbortController().signal),
  ).rejects.toBeInstanceOf(PlatformAccessError);
  read.info.verificationRequired = false;
  read.info.accountId = 'b';
  await expect(
    loadedLearningCard(ref, item, course, 'a', new AbortController().signal),
  ).rejects.toThrow(/账号/);
});
it('login loss and cancellation reject the snapshot before any fallback', async () => {
  read.info.loginRequired = true;
  await expect(
    loadedLearningCard(ref, item, course, 'a', new AbortController().signal),
  ).rejects.toThrow(/登录/);
  read.info.loginRequired = false;
  const controller = new AbortController();
  mocks.read.mockImplementation(async () => {
    controller.abort();
    return read;
  });
  await expect(
    loadedLearningCard(ref, item, course, 'a', controller.signal),
  ).rejects.toThrow(/取消/);
});
it('matches default card zero and changing navigation signatures without merging courses', () => {
  expect(sameCardPage(URL, URL.replace('&num=0', '') + '&enc=temporary')).toBe(
    true,
  );
  expect(sameCardPage(URL, URL.replace('courseid=100', 'courseid=101'))).toBe(
    false,
  );
  expect(sameCardPage(URL, URL + '&cpi=other')).toBe(false);
});
it('a loaded 9010 page stops parsing rather than becoming an empty task list', () => {
  expect(() =>
    parseLearningCards(
      inertDocument('<h1>【9010】操作异常，请输入图片中的验证码</h1>'),
      URL,
      course,
      '300',
    ),
  ).toThrow(PlatformAccessError);
});

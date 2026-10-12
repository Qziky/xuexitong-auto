import { describe, it, expect } from 'vitest';
import { allowedPlatformRead } from '../src/platform-reader';

describe('legacy chapter draft and receipt verification access', () => {
  const task = 'https://mooc1.chaoxing.com/mooc-ans/work/doHomeWorkNew?courseId=1&classId=2&workId=3';
  const receipt = 'https://mooc1.chaoxing.com/mooc-ans/work/prompt?courseId=1&classId=2&workId=3&answerId=4';
  it('allows the actual task-bound legacy draft and submission receipt only for result reads', () => {
    for (const url of [task, receipt]) {
      expect(allowedPlatformRead(url, 'result')).toBe(true);
      for (const purpose of ['catalog', 'navigation', 'homework-list', 'learning', undefined] as const)
        expect(allowedPlatformRead(url, purpose)).toBe(false);
    }
  });
  it('keeps unbound, foreign, and write endpoints excluded', () => {
    for (const url of [
      task.replace('&workId=3', ''), task.replace('&classId=2', ''),
      receipt.replace('&answerId=4', ''), receipt.replace('answerId=4','answerId=0'),
      task.replace('/doHomeWorkNew', '/addStudentWorkNew'),
      task.replace('mooc1.chaoxing.com', 'example.com'),
    ]) expect(allowedPlatformRead(url, 'result')).toBe(false);
  });
});

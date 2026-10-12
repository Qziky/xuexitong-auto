import { expect, it } from 'vitest';
import {
  isFreshLearningDocumentFrame,
  matchesLearningNavigation,
} from '../src/learning-navigation';

const entry =
  'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=100&clazzid=200&cpi=300&ismooc2=1&v=1';
const redirected =
  'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=100&clazzid=200&cpi=300&enc=new&t=99&hideHead=0';
it('accepts the native course redirect by course/class/enrollment identity, including rotated signatures', () => {
  expect(matchesLearningNavigation(redirected, entry)).toBe(true);
  expect(
    matchesLearningNavigation(
      redirected.replace('enc=new', 'enc=changed'),
      redirected,
    ),
  ).toBe(true);
  expect(matchesLearningNavigation(entry, entry)).toBe(true);
});
it.each(['courseid', 'clazzid', 'cpi'])(
  'rejects a course redirect with another %s',
  (key) => {
    const wrong = new URL(redirected);
    wrong.searchParams.set(key, '999');
    expect(matchesLearningNavigation(wrong.href, entry)).toBe(false);
    wrong.searchParams.delete(key);
    expect(matchesLearningNavigation(wrong.href, entry)).toBe(false);
  },
);
it('does not accept a login page, card, foreign origin or incomplete course identity as a redirect', () => {
  expect(
    matchesLearningNavigation(
      redirected.replace('mycourse/stu', 'knowledge/cards'),
      entry,
    ),
  ).toBe(false);
  expect(
    matchesLearningNavigation(
      redirected.replace('mooc2-ans.chaoxing.com', 'example.com'),
      entry,
    ),
  ).toBe(false);
  expect(
    matchesLearningNavigation('https://passport2.chaoxing.com/login', entry),
  ).toBe(false);
  expect(
    matchesLearningNavigation(redirected, entry.replace('&cpi=300', '')),
  ).toBe(false);
  const card = 'https://mooc1.chaoxing.com/knowledge/cards?knowledgeid=1';
  expect(matchesLearningNavigation(card, card)).toBe(true);
  expect(matchesLearningNavigation(card.replace('id=1', 'id=2'), card)).toBe(
    false,
  );
});

it('waits for the new requested top-level document before validating account identity', () => {
  const requested =
    'https://mooc1.chaoxing.com/visit/stucoursemiddle?courseid=100&clazzid=200&cpi=300';
  expect(
    isFreshLearningDocumentFrame(
      {
        top: true,
        url: 'https://detect.chaoxing.com/api/monitor_temp',
        documentId: 'previous',
      },
      requested,
      'previous',
    ),
  ).toBe(false);
  expect(
    isFreshLearningDocumentFrame(
      { top: true, url: requested, documentId: 'new' },
      requested,
      'previous',
    ),
  ).toBe(true);
  expect(
    isFreshLearningDocumentFrame(
      { top: false, url: requested, documentId: 'new' },
      requested,
      'previous',
    ),
  ).toBe(false);
  expect(
    isFreshLearningDocumentFrame(
      { top: true, url: requested, documentId: 'previous' },
      requested,
      'previous',
    ),
  ).toBe(false);
});

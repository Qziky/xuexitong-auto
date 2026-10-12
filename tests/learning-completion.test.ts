import { expect, it, vi } from 'vitest';
import {
  attachmentCompletion,
  catalogCompletion,
} from '../src/learning-completion';
import {
  learningMenu,
  learningCardMenu,
  openLearningCard,
  openLearningChapter,
  parseLearningCards,
} from '../src/learning-parser';
import { inertDocument } from '../src/scan-parser';
const url =
  'https://mooc1.chaoxing.com/knowledge/cards?courseid=1&clazzid=2&knowledgeid=3&num=0';
const course = { id: 'c', accountId: 'a', courseId: '1', classId: '2' } as any;
it('a fresh known DOCX can retire its job field after the native completion callback', () => {
  const doc = inertDocument(
    '<script>var mArg={"attachments":[{"jobid":"d","type":"document","property":{"objectid":"object-d"}}]};</script>',
  );
  const knownReadingTask = { jobId: 'd', objectId: 'object-d' };
  expect(
    parseLearningCards(doc, url, course, '3', {
      fresh: true,
      knownReadingTask,
    })[0],
  ).toMatchObject({
    platformComplete: true,
    completionState: 'confirmed',
    completionEvidence: { fresh: true, source: 'configuration' },
  });
  expect(
    parseLearningCards(doc, url, course, '3', { knownReadingTask })[0]
      ?.platformComplete,
  ).not.toBe(true);
  expect(
    parseLearningCards(doc, url, course, '3', { fresh: true })[0]
      ?.platformComplete,
  ).not.toBe(true);
  expect(
    parseLearningCards(doc, url, course, '3', {
      fresh: true,
      knownReadingTask: { jobId: 'd', objectId: 'other' },
    })[0]?.platformComplete,
  ).not.toBe(true);
});
it('missing job flags in DOM-only metadata, video or mismatched/explicitly incomplete configuration do not prove completion', () => {
  const options = {
    fresh: true,
    knownReadingTask: { jobId: 'd', objectId: 'object-d' },
  };
  const samples = [
    '<iframe data="{&quot;jobid&quot;:&quot;d&quot;,&quot;type&quot;:&quot;document&quot;,&quot;objectid&quot;:&quot;object-d&quot;}"></iframe>',
    ...[
      '"job":true,',
      '"job":null,',
      '"job":0,',
      '"job":"false",',
      '"isPassed":false,',
    ].map(
      (flag) =>
        `<script>var mArg={"attachments":[{${flag}"jobid":"d","type":"document","property":{"objectid":"object-d"}}]};</script>`,
    ),
    '<script>var mArg={"attachments":[{"jobid":"d","type":"video","property":{"objectid":"object-d"}}]};</script>',
  ];
  for (const html of samples)
    expect(
      parseLearningCards(inertDocument(html), url, course, '3', options)[0]
        ?.platformComplete,
    ).not.toBe(true);
});
it('outer completed wrapper is accepted, but nested resource completion belongs only to that resource', () => {
  const doc = inertDocument(
    '<div class="ans-attach-ct ans-job-finished"><i class="ans-job-icon" aria-label="任务点"></i><iframe data="{&quot;jobid&quot;:&quot;v&quot;,&quot;type&quot;:&quot;video&quot;}"></iframe></div><div class="ans-attach-ct" id="parent"><div class="ans-attach-ct ans-job-finished"><i class="ans-job-icon" aria-label="任务点已完成"></i></div><iframe data="{&quot;jobid&quot;:&quot;d&quot;,&quot;type&quot;:&quot;document&quot;}"></iframe></div>',
  );
  const items = parseLearningCards(doc, url, course, '3');
  expect(items[0]).toMatchObject({
    phase: 'done',
    completionState: 'confirmed',
  });
  expect(items[1]).toMatchObject({
    phase: 'waiting',
    completionState: 'unknown',
  });
  expect(attachmentCompletion(doc.querySelector('#parent'))).toBe('unknown');
});
it('old completion class versus explicit unfinished label remains conflicted until fresh server data resolves it', () => {
  const make = (passed: boolean) =>
    inertDocument(
      `<script>var mArg={"attachments":[{"jobid":"v","type":"video","isPassed":${passed}}]};</script><div class="ans-attach-ct ans-job-finished"><i class="ans-job-icon" aria-label="任务点未完成"></i><iframe data="{&quot;jobid&quot;:&quot;v&quot;}"></iframe></div>`,
    );
  expect(
    parseLearningCards(make(true), url, course, '3')[0]?.completionState,
  ).toBe('conflict');
  expect(
    parseLearningCards(make(true), url, course, '3', { fresh: true })[0],
  ).toMatchObject({
    completionState: 'confirmed',
    platformComplete: true,
    completionEvidence: { fresh: true, source: 'configuration' },
  });
  expect(
    parseLearningCards(make(false), url, course, '3', { fresh: true })[0],
  ).toMatchObject({ completionState: 'incomplete', platformComplete: false });
});
it('positive pending count overrides a completion icon; zero pending alone proves nothing', () => {
  const doc = inertDocument(
    '<li id="positive"><i class="icon_Completed"></i><b class="jobUnfinishCount">1</b><a data-knowledgeid="3">c</a></li><li id="zero"><b class="jobUnfinishCount">0</b><a data-knowledgeid="4">d</a></li>',
  );
  expect(catalogCompletion(doc.querySelector('#positive')!)).toBe('conflict');
  expect(catalogCompletion(doc.querySelector('#zero')!)).toBe('unknown');
  expect(learningMenu(doc, url).chapters.every((c) => !c.complete)).toBe(true);
});
it('nested chapter icons never finish the outer chapter', () => {
  const doc = inertDocument(
    '<li><a data-knowledgeid="3">parent</a><ul><li><i class="icon_Completed"></i><a data-knowledgeid="4">child</a></li></ul></li>',
  );
  expect(learningMenu(doc, url).chapters.map((c) => c.complete)).toEqual([
    false,
    true,
  ]);
});
it('chapter and card navigation tolerate title changes and DOM redraw without selecting a different ID', () => {
  const doc = inertDocument(
    '<li><a data-knowledgeid="3" onclick="getTeacherAjax(1,2,3)">old</a></li><span id="dct1" cardid="1" onclick="changeDisplayContent(1)">old</span>',
  );
  const menu = learningMenu(doc, url),
    cards = learningCardMenu(doc, url);
  doc.querySelector('li')!.innerHTML =
    '<a data-knowledgeid="3" onclick="getTeacherAjax(1,2,3)">new</a>';
  doc.querySelector('span')!.textContent = 'new';
  const click = vi.fn();
  (doc.querySelector('a') as HTMLElement).click = click;
  openLearningChapter(doc, url, menu.chapters[0]!.actionId, menu.fingerprint);
  (doc.querySelector('span') as HTMLElement).click = click;
  openLearningCard(doc, url, cards.cards[0]!.actionId, cards.fingerprint);
  expect(click).toHaveBeenCalledTimes(2);
  doc.querySelector('span')!.setAttribute('cardid', '2');
  expect(() =>
    openLearningCard(doc, url, cards.cards[0]!.actionId, cards.fingerprint),
  ).toThrow(/变化/);
});

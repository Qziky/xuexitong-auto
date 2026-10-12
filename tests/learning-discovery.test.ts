import { expect, it } from 'vitest';
import {
  parseLearningCards,
  learningCardMenu,
  openLearningCard,
} from '../src/learning-parser';
import { inertDocument } from '../src/scan-parser';
import { initialState, type CourseRecord } from '../src/domain';
import { migrateState } from '../src/state-migration';
import { createQueue } from '../src/queue';
const course = { id: '1:2', accountId: 'cx:1' } as CourseRecord;
const url =
  'https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?knowledgeid=3&num=1';
it('binds native card controls to their declared chapter, including a conflicting header', () => {
  const doc = inertDocument(
    `<span id="dct1" cardid="a" onclick="changeDisplayContent(1,2,'123','1','2','');">video</span><span id="dct2" cardid="b" onclick="changeDisplayContent(2,2,'123','1','2','');">document</span>`,
  );
  expect(learningCardMenu(doc, url).chapterId).toBe('123');
  doc
    .querySelector('#dct2')!
    .setAttribute('onclick', "changeDisplayContent(2,2,'124','1','2','');");
  expect(learningCardMenu(doc, url).chapterId).toBe('conflict');
});
it('mixed cards retain real task types and exclude explicit non-task resources with object ids', () => {
  const attachments = [
    { job: true, jobid: 'v', type: 'video', property: { objectid: 'v' } },
    { job: true, jobid: 'a', type: 'audio', property: { objectid: 'a' } },
    {
      job: true,
      jobid: 'd',
      type: 'document',
      property: { objectid: 'd', type: '.pdf' },
    },
    { job: true, jobid: 'p', property: { module: 'insertppt', objectid: 'p' } },
    { job: true, jobid: 'i', type: 'image', property: { objectid: 'i' } },
    {
      job: false,
      jobid: 'not-a-task',
      type: 'video',
      property: { objectid: 'n' },
    },
    {
      job: true,
      jobid: 'unknown',
      property: { objectid: 'u', module: 'downloadfile' },
    },
  ];
  const doc = inertDocument(
    '<script>mArg = ' + JSON.stringify({ attachments }) + '</script>',
  );
  const items = parseLearningCards(doc, url, course, '3');
  expect(items.map((i) => i.type)).toEqual([
    'video',
    'audio',
    'document',
    'document',
    'image',
    'unknown',
  ]);
  expect(items.every((i) => i.card?.id === '1')).toBe(true);
});
it('finished card marker overrides an absent configuration flag without duplicating the task', () => {
  const doc = inertDocument(
    '<script>mArg={"attachments":[{"job":true,"jobid":"d","type":"document","property":{"objectid":"x"}}]}</script><div class="ans-attach-ct"><span class="ans-job-icon ans-job-finished"></span><iframe data=\'{"jobid":"d","objectid":"x","type":".pdf"}\'></iframe></div>',
  );
  const items = parseLearningCards(doc, url, course, '3');
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    type: 'document',
    platformComplete: true,
    phase: 'done',
    completionEvidence: { source: 'card-marker' },
  });
});
it('all three actual card controls have distinct bound actions and stale menus cannot navigate', () => {
  const doc = inertDocument(
    '<div id="dct1" cardid="c1" onclick="changeDisplayContent(1,3)">视频</div><div id="dct2" cardid="c2" onclick="changeDisplayContent(2,3)">课件</div><div id="dct3" cardid="c3" onclick="changeDisplayContent(3,3)">图片</div>',
  );
  const menu = learningCardMenu(doc, url);
  expect(menu.cards).toHaveLength(3);
  expect(new Set(menu.cards.map((c) => c.actionId)).size).toBe(3);
  doc.querySelector('#dct2')?.remove();
  expect(() =>
    openLearningCard(doc, url, menu.cards[1]!.actionId, menu.fingerprint),
  ).toThrow('变化');
});
it('upgrade pauses an old queue and preserves its scope instead of adding new task types', () => {
  const old = initialState();
  old.learning.phase = 'running';
  old.learning.range = 'video';
  const updated = migrateState(old);
  expect(updated.learning.phase).toBe('paused');
  expect(updated.learning.selectedTypes).toEqual(['video']);
  expect(updated.learning.foregroundFallback).toBe(true);
});
it('native viewing condition is retained and explicit completed jobs survive a non-job configuration flag', () => {
  const doc = inertDocument(
    '<script>mArg={"attachments":[{"job":true,"jobid":"v","type":"video","property":{"objectid":"v"}},{"job":false,"isPassed":true,"jobid":"d","type":"document"}]}</script><div class="ans-attach-ct">观看时长需 ≥ 总时长的 50%<i class="ans-job-icon"></i><iframe data=\'{"jobid":"v","objectid":"v"}\'></iframe></div>',
  );
  const items = parseLearningCards(doc, url, course, '3');
  expect(items[0]!.completion?.ratio).toBe(0.5);
  expect(items[1]).toMatchObject({
    type: 'document',
    phase: 'done',
    platformComplete: true,
  });
});
it('a discovered unlisted chapter quiz can execute, while analysis-only references cannot', () => {
  const doc = inertDocument(
    '<script>mArg={"attachments":[{"job":true,"jobid":"work-900","type":"work","property":{"workid":"900"}}]}</script>',
  );
  const task = parseLearningCards(doc, url, course, '3')[0]!.task!;
  expect(task.listed).toBe(false);
  expect(
    createQueue([task], 'cx:1', 'preserve', 'submit').items[0]!.taskId,
  ).toBe(task.id);
  expect(() =>
    createQueue([{ ...task, analysisOnly: true }], 'cx:1', 'preserve'),
  ).toThrow('请选择');
});
it('recognizes chapter work modules with non-numeric platform work IDs', () => {
  const doc = inertDocument(
    '<script>mArg={"attachments":[{"job":true,"jobid":"task-entry","type":"workid","property":{"module":"work","type":"work","workid":"opaque-work-id","name":"Chapter Two - Test"}}]}</script>',
  );
  const item = parseLearningCards(doc, url, course, '3')[0]!;
  expect(item.type).toBe('quiz');
  expect(item.task).toMatchObject({
    type: 'quiz',
    title: 'Chapter Two - Test',
    platformId: 'opaque-work-id',
  });
});

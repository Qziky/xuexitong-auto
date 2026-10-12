import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tool, evaluation, ROOT } from './debug/environment.mjs';
import { openPage } from './debug/live-session.mjs';
const directory = resolve(ROOT, 'artifacts/private');
await mkdir(directory, { recursive: true });
const page = await openPage(
  'http://127.0.0.1:5217/learning-benchmark.html',
  false,
);
const evalAt = (fn) =>
  tool('evaluate_script', {
    pageId: page.id,
    function: fn,
    waitForStableDom: false,
  }).then(evaluation);
const results = [];
let holder;
try {
  for (const background of [false, true]) {
    if (background)
      holder = await openPage(
        'http://127.0.0.1:5217/learning-fixture.html',
        false,
      );
    for (const pace of [250, 1000]) {
      const result = await evalAt(
        `async()=>window.runLearningBenchmark(${pace})`,
      );
      results.push({
        ...result,
        requestedContext: background ? 'background' : 'foreground',
      });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  await writeFile(
    resolve(directory, 'learning-performance-current.json'),
    JSON.stringify(
      { source: 'current checkout', at: new Date().toISOString(), results },
      null,
      2,
    ) + '\n',
  );
} finally {
  await tool('close_page', { pageId: page.id }).catch(() => {});
  if (holder) await tool('close_page', { pageId: holder.id }).catch(() => {});
}

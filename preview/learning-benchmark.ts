import {
  ReadingAdapter,
  type ReaderDescription,
} from '../src/learning-adapters';
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = document.querySelector<HTMLElement>('#reader')!;
const scope = new Proxy(document, {
  get(target, key) {
    if (key === 'body') return root.parentElement!;
    if (key === 'querySelector')
      return root.parentElement!.querySelector.bind(root.parentElement!);
    if (key === 'querySelectorAll')
      return root.parentElement!.querySelectorAll.bind(root.parentElement!);
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
Object.assign(window, {
  async runLearningBenchmark(
    intervalMs: number,
  ) {
    const Adapter = ReadingAdapter;
    root.querySelector('article')!.innerHTML = Array.from(
      { length: 6 },
      (_, i) => '<section>屏幕 ' + (i + 1) + '</section>',
    ).join('');
    root.scrollTop = 0;
    await delay(50);
    const actions: number[] = [];
    let authorizations = 0,
      messages = 0,
      last: ReaderDescription | undefined;
    const started = performance.now(),
      visibility = document.visibilityState;
    const listener = () => {
      actions.push(Math.round(performance.now() - started));
    };
    root.addEventListener('scroll', listener);
    const adapter = new Adapter(
      scope,
      async () => {
        authorizations++;
        return true;
      },
      async (_binding: unknown, state: ReaderDescription) => {
        messages++;
        last = state;
        return true;
      },
    );
    try {
      await adapter.start(
        {
          learningId: 'benchmark',
          runId: 'benchmark',
          itemId: 'benchmark',
          accountId: 'fixture',
          lease: 'fixture',
        },
        undefined,
        { readingIntervalMs: intervalMs, preferredPlaybackRate: 1 },
      );
      const deadline = performance.now() + 30000;
      while (!last?.finished && performance.now() < deadline) await delay(50);
      if (!last?.finished)
        throw new Error('阅读夹具未完成：' + JSON.stringify(last));
      const result = {
        engine: 'current',
        intervalMs,
        visibility,
        totalMs: Math.round(performance.now() - started),
        firstActionMs: actions[0],
        actions,
        actionIntervalsMs: actions.slice(1).map((at, i) => at - actions[i]!),
        authorizations,
        messages,
        position: root.scrollTop,
        extent: root.scrollHeight - root.clientHeight,
      };
      document.querySelector('#result')!.textContent = JSON.stringify(
        result,
        null,
        2,
      );
      return result;
    } finally {
      adapter.pause();
      root.removeEventListener('scroll', listener);
    }
  },
});

import type { EventRecord, LogEvent, OperationProgress } from '../domain';
import { diagnosticUrl, redact, hashText } from '../security';

export interface LogQuery {
  runId?: string;
  taskId?: string;
  stage?: string;
  level?: string;
  search?: string;
  cursor?: [number, string];
  limit?: number;
}
let dbPromise: Promise<IDBDatabase> | undefined;
let writes = Promise.resolve();
const pendingRuns = new Map<string, OperationProgress>();
const pendingEvents: LogEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleFlush(): void {
  flushTimer ??= setTimeout(() => void flushJournal(), 250);
  if (pendingEvents.length >= 50) void flushJournal();
}
export function flushJournal(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!pendingRuns.size && !pendingEvents.length) return writes;
  const runs = [...pendingRuns.values()];
  const events = pendingEvents.splice(0);
  pendingRuns.clear();
  return enqueue(async () => {
    const tx = (await database()).transaction(['runs', 'events'], 'readwrite');
    for (const run of runs) tx.objectStore('runs').put(run);
    for (const event of events) tx.objectStore('events').put(event);
    await committed(tx);
  });
}
let onError: (note: string) => void = () => {};
let secrets: () => string[] = () => [];
function journalTaskId(id?: string): string | undefined {
  return !id
    ? undefined
    : /^task:[0-9a-f]{8}$/.test(id)
      ? id
      : `task:${hashText(id)}`;
}
export function configureJournal(
  error: typeof onError,
  keys: typeof secrets,
): void {
  onError = error;
  secrets = keys;
}
export function safeLogText(value: string): string {
  let text = String(value);
  for (const secret of secrets().filter(Boolean))
    text = text.split(secret).join('[凭据已隐藏]');
  return redact(text)
    .replace(/https?:\/\/[^\s<>"']+/g, (url) => diagnosticUrl(url))
    .replace(/(?:cookie|authorization)\s*[:=]\s*[^\n]+/gi, '[凭据已隐藏]')
    .replace(
      /\b(?:enc|token|ktoken|utenc|stuenc|standardEnc)\s*[:=]\s*[^\s&,;]+/gi,
      '[令牌已隐藏]',
    )
    .replace(/data:(?:image|font|application)\/[^\s"']+/gi, '[资源已隐藏]')
    .slice(0, 600);
}
function database(): Promise<IDBDatabase> {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('chaoxing-execution-journal', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('runs'))
          db.createObjectStore('runs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('events')) {
          const events = db.createObjectStore('events', { keyPath: 'id' });
          events.createIndex('order', ['at', 'id']);
          events.createIndex('runId', 'runId');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          dbPromise = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        dbPromise = undefined;
        reject(new Error('日志数据库无法打开'));
      };
      request.onblocked = () => reject(new Error('日志数据库正在升级'));
    });
  return dbPromise;
}
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error('日志写入失败'));
  });
}
function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('日志读取失败'));
  });
}
function enqueue(job: () => Promise<void>): Promise<void> {
  writes = writes
    .catch(() => {})
    .then(job)
    .catch(() => {
      onError('日志保存失败；当前进度仍可查看，请检查本机存储后重新导出');
    });
  return writes;
}
export function putRun(run: OperationProgress): Promise<void> {
  const copy = structuredClone(run);
  delete copy.accountId;
  copy.taskId = journalTaskId(copy.taskId);
  copy.title = safeLogText(copy.title);
  copy.note = safeLogText(copy.note);
  pendingRuns.set(copy.id, copy);
  scheduleFlush();
  return Promise.resolve();
}
export function appendEvent(event: LogEvent): Promise<void> {
  // Explicit allowlist: never spread a model/page object into persistent logs.
  const copy: LogEvent = {
    id: event.id,
    runId: event.runId,
    at: event.at,
    seq: event.seq,
    level: event.level,
    stage: safeLogText(event.stage),
    taskId: journalTaskId(event.taskId),
    code: safeLogText(event.code),
    message: safeLogText(event.message),
    questionNumber: event.questionNumber,
    part: event.part ? safeLogText(event.part) : undefined,
    engine: event.engine,
    confidence: event.confidence,
    attempt: event.attempt,
    durationMs: event.durationMs,
    done: event.done,
    total: event.total,
    readSource: event.readSource,
  };
  pendingEvents.push(copy);
  scheduleFlush();
  return Promise.resolve();
}
export async function queryRuns(): Promise<OperationProgress[]> {
  await flushJournal();
  const db = await database();
  return (
    await read<OperationProgress[]>(
      db.transaction('runs').objectStore('runs').getAll(),
    )
  ).sort((a, b) => b.startedAt - a.startedAt);
}
export async function queryLogs(
  query: LogQuery = {},
): Promise<{ events: LogEvent[]; cursor?: [number, string] }> {
  await flushJournal();
  const db = await database();
  const limit = Math.max(1, Math.min(200, query.limit ?? 100));
  return new Promise((resolve, reject) => {
    const events: LogEvent[] = [];
    const index = db.transaction('events').objectStore('events').index('order');
    const request = index.openCursor(
      query.cursor ? IDBKeyRange.upperBound(query.cursor, true) : undefined,
      'prev',
    );
    request.onerror = () => reject(new Error('日志读取失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ events });
        return;
      }
      const event = cursor.value as LogEvent;
      const matches =
        (!query.runId || event.runId === query.runId) &&
        (!query.taskId || event.taskId === journalTaskId(query.taskId)) &&
        (!query.stage || event.stage === query.stage) &&
        (!query.level || event.level === query.level) &&
        (!query.search ||
          `${event.message} ${event.code} ${event.questionNumber ?? ''} ${event.part ?? ''}`
            .toLowerCase()
            .includes(query.search.toLowerCase()));
      if (matches) events.push(event);
      if (events.length === limit) {
        resolve({ events, cursor: [event.at, event.id] });
        return;
      }
      cursor.continue();
    };
  });
}
export async function exportLogs(
  query: LogQuery = {},
): Promise<{ runs: OperationProgress[]; events: LogEvent[] }> {
  const events: LogEvent[] = [];
  let cursor: LogQuery['cursor'];
  do {
    const page = await queryLogs({ ...query, cursor, limit: 200 });
    events.push(...page.events);
    cursor = page.cursor;
  } while (cursor);
  const ids = new Set(events.map((e) => e.runId));
  return {
    runs: (await queryRuns()).filter((r) => ids.has(r.id)),
    events: events.reverse(),
  };
}
export async function pruneJournal(now = Date.now()): Promise<void> {
  const runs = await queryRuns();
  const ended = runs.filter(
    (r) => !['running', 'waiting-user'].includes(r.phase),
  );
  const remove = ended
    .filter((r, i) => i >= 100 || r.updatedAt < now - 7 * 86400000)
    .map((r) => r.id);
  if (!remove.length) return;
  await removeRuns(remove);
}
async function removeRuns(ids: string[]): Promise<void> {
  await enqueue(async () => {
    const tx = (await database()).transaction(['runs', 'events'], 'readwrite');
    for (const id of ids) {
      tx.objectStore('runs').delete(id);
      const request = tx
        .objectStore('events')
        .index('runId')
        .openCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
    }
    await committed(tx);
  });
}
export async function clearLogs(): Promise<void> {
  await removeRuns(
    (await queryRuns())
      .filter((r) => !['running', 'waiting-user'].includes(r.phase))
      .map((r) => r.id),
  );
}
export async function initJournal(legacy: EventRecord[]): Promise<void> {
  try {
    const runs = await queryRuns();
    for (const run of runs.filter((r) => r.phase === 'running')) {
      const latest = (await queryLogs({ runId: run.id, limit: 1 })).events[0];
      run.seq = Math.max(run.seq, latest?.seq ?? 0) + 1;
      run.phase = 'cancelled';
      run.finishedAt = run.updatedAt = Date.now();
      run.note = '后台已重启，上次运行中断';
      await putRun(run);
      await appendEvent({
        id: `${run.id}:${String(run.seq).padStart(9, '0')}`,
        runId: run.id,
        at: Date.now(),
        seq: run.seq,
        level: 'warn',
        stage: run.stage,
        code: 'interrupted',
        message: run.note,
      });
    }
    const db = await database();
    const imported = await read(
      db.transaction('meta').objectStore('meta').get('legacy-imported'),
    );
    if (!imported && legacy.length && !runs.some((r) => r.id === 'legacy-v2')) {
      const at = legacy[0]!.at;
      await putRun({
        id: 'legacy-v2',
        title: '旧版活动记录',
        kind: 'legacy',
        phase: 'done',
        stage: 'checking',
        startedAt: at,
        stageStartedAt: at,
        updatedAt: Date.now(),
        lastHeartbeatAt: at,
        lastProgressAt: at,
        finishedAt: Date.now(),
        note: '升级前的简短日志',
        seq: legacy.length,
      });
      for (const [i, e] of legacy.entries())
        await appendEvent({
          ...e,
          id: `legacy-v2:${i}`,
          runId: 'legacy-v2',
          seq: i,
          stage: 'legacy',
          code: 'legacy',
          message: e.text,
        });
    }
    await enqueue(async () => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(true, 'legacy-imported');
      await committed(tx);
    });
    await pruneJournal();
  } catch {
    onError('日志数据库暂不可用；当前进度仍可查看');
  }
}

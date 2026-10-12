import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { control, tool, resultText, evaluation, ROOT } from './environment.mjs';

export const REPORT = resolve(ROOT, 'artifacts/private/0.5.5-live.json');

export function safeText(value = '') {
  return String(value)
    .replace(/sk-[a-z0-9_-]+/gi, '[credential]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [credential]')
    .replace(/https?:\/\/[^\s<>"')]+/g, (url) => {
      try {
        const parsed = new URL(url);
        return parsed.origin + parsed.pathname;
      } catch {
        return '[address]';
      }
    })
    .replace(/\b(enc|token|signature|cookie|api[_-]?key)\s*[:=]\s*[^\s;,]+/gi, '$1=[redacted]');
}

export function authorizedTask(
  state,
  task,
  targets = {
    quizCourse: process.env.XUEXITONG_TEST_QUIZ_COURSE?.trim(),
    homeworkCourse: process.env.XUEXITONG_TEST_HOMEWORK_COURSE?.trim(),
    homeworkTitle: process.env.XUEXITONG_TEST_HOMEWORK_TITLE?.trim(),
  },
) {
  if (!task || task.accountId !== state.accountId || task.analysisOnly) return false;
  const course = state.courses.find((c) => c.id === task.courseId);
  return Boolean(
    course &&
      ((targets.quizCourse &&
        course.title === targets.quizCourse &&
        task.type === 'quiz') ||
        (targets.homeworkCourse &&
          targets.homeworkTitle &&
          course.title === targets.homeworkCourse &&
          task.type === 'homework' &&
          task.title === targets.homeworkTitle)),
  );
}
export function actionFinished(state, taskId, since, action) {
  const workflow = state.workflows[taskId];
  const operation = workflow && state.operations[workflow.runId];
  return !!operation && workflow.action === action && workflow.phase !== 'running' && operation.lastProgressAt >= since;
}

export function summarize(state) {
  const q = state.learning;
  const item = q.items[q.index];
  return {
    schema: state.schema,
    accountKnown: !!state.accountId,
    configured: !!state.provider.hasKey,
    block: !!state.platformBlock,
    scan: { phase: state.scan.phase, note: safeText(state.scan.note) },
    courses: state.courses.map((c) => ({ title: c.title, points: c.taskPoints, homework: c.homeworkCounts })),
    learning: {
      phase: q.phase, index: q.index, discovered: q.items.length,
      note: safeText(q.note), tabId: q.tabId,
      current: item && { title: item.title, type: item.type, phase: item.phase, position: item.position, duration: item.duration, page: item.currentPage, pages: item.totalPages, note: safeText(item.note), errorCode: item.errorCode },
      items: q.items.map((i) => ({ title: i.title, chapter: i.chapterTitle, chapterId: i.chapterId, type: i.type, phase: i.phase, complete: i.platformComplete, note: safeText(i.note), errorCode: i.errorCode })),
    },
    queue: { phase: state.queue.phase, index: state.queue.index, items: state.queue.items.map(i=>({phase:i.phase,note:safeText(i.note)})) },
    currentPage: state.currentPage && { kind: state.currentPage.kind, tabId: state.currentPage.tabId, workspaceId: state.currentPage.workspaceId },
    workspaces: Object.values(state.workspaces).map(w=>({id:w.id,title:w.task.title,type:w.task.type,status:w.task.status,count:w.task.questionCount,capabilities:w.capabilities})),
    runs: Object.values(state.operations).slice(-8).map(o=>({id:o.id,kind:o.kind,title:o.title,phase:o.phase,stage:o.stage,note:safeText(o.note),startedAt:o.startedAt,finishedAt:o.finishedAt,lastHeartbeatAt:o.lastHeartbeatAt,lastProgressAt:o.lastProgressAt})),
    preparations: Object.values(state.preparations).map(p=>({taskId:p.taskId,phase:p.phase,decoded:p.decoded,count:p.snapshot?.questions.length,textReview:p.snapshot?.questions.filter(q=>q.issues.length).length,proposals:p.proposals?.length,answerReview:p.proposals?.filter(a=>a.needsReview).length,note:safeText(p.note)})),
    workflows: Object.values(state.workflows).map(w=>({taskId:w.taskId,phase:w.phase,stage:w.stage,filled:w.filled,readbackVerified:w.readbackVerified,draftAttempted:w.draftAttempted,draftVerified:w.draftVerified,submitAttempted:w.submitAttempted,note:safeText(w.note)})),
  };
}

export async function session() {
  const health = await control('/health');
  if (health.phase !== 'ready') throw new Error('专用 Edge 调试服务未就绪');
  const pages = await tool('list_pages');
  const panelUrl = `chrome-extension://${health.extensionId}/sidepanel.html`;
  let panel = (pages.structuredContent.extensionPages ?? []).find(p=>p.url===panelUrl);
  if (!panel) panel = await openPage(panelUrl, true);
  return {
    panel: panel.id,
    async evaluate(fn, pageId = panel.id) {
      return evaluation(await tool('evaluate_script', {pageId,function:`async (...args) => Promise.race([(${fn})(...args), new Promise((_, reject) => setTimeout(() => reject(new Error('验收读取超过 20 秒，结果已放弃')), 20000))])`,waitForStableDom:false}));
    },
    async state() {
      return this.evaluate(`async () => {const r=await chrome.runtime.sendMessage({target:'background',kind:'state'});if(!r.ok)throw new Error(r.error);return r.value;}`);
    },
    async click(label) {
      const text=resultText(await tool('take_snapshot',{pageId:panel.id}));
      const lines=text.split('\n').filter(l=>l.includes(`button "${label}"`));
      if(lines.length!==1)throw new Error(`按钮无法唯一定位：${label} (${lines.length})`);
      if(/disabled/.test(lines[0]))throw new Error(`按钮尚不可用：${label}`);
      const uid=lines[0].match(/uid=([^\s]+)/)?.[1];
      await tool('click',{pageId:panel.id,uid});
    },
    async current() {
      const ui = await this.ui();
      await this.click(ui.buttons.some(b=>b.text==='返回当前页') ? '返回当前页' : '当前页');
    },
    async ui() {
      return this.evaluate(`() => ({headings:[...document.querySelectorAll('h1,h2')].map(h=>h.innerText),buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText.trim(),disabled:b.disabled})).filter(b=>b.text),warnings:[...document.querySelectorAll('.warning,.error-banner')].map(e=>e.innerText),width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth})`);
    },
  };
}

export async function openPage(url, background = false) {
  const before = (await tool('list_pages')).structuredContent;
  const ids = new Set([...(before.pages??[]),...(before.extensionPages??[])].map(p=>p.id));
  const result = await tool('new_page',{url,background,timeout:30000});
  const added = [...(result.structuredContent.pages??[]),...(result.structuredContent.extensionPages??[])].filter(p=>!ids.has(p.id));
  if(added.length!==1)throw new Error('无法唯一确认新打开的验收页');
  return added[0];
}

export async function waitFor(s, predicate, timeout = 60000) {
  const end = Date.now()+timeout;
  while (Date.now()<end) {
    const state = await s.state();
    if(state.platformBlock)throw new Error('平台验证或限流，真实验收已停止');
    if(predicate(state))return state;
    await new Promise(r=>setTimeout(r,500));
  }
  throw new Error('验收等待超时；保留当前流程供诊断');
}

export async function record(name, status, evidence = {}) {
  await mkdir(resolve(ROOT,'artifacts/private'),{recursive:true});
  let report;
  try { report=JSON.parse(await readFile(REPORT,'utf8')); }
  catch(error) {if(error.code!=='ENOENT')throw error;report={version:'0.5.5',startedAt:new Date().toISOString(),cases:[]};}
  report.cases.push({name,status,at:new Date().toISOString(),evidence});
  const text=JSON.stringify(report,null,2);
  if(/sk-[a-z0-9_-]+|Bearer\s+[^\[]|[?&](?:enc|token|signature)=/i.test(text))throw new Error('报告含敏感信息，拒绝写入');
  await writeFile(REPORT,text+'\n');
}

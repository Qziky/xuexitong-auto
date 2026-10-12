import { session, summarize, authorizedTask, actionFinished, record, waitFor, safeText } from './debug/live-session.mjs';

const name=process.argv.find(a=>a.startsWith('--case='))?.slice(7)||'check';
const execute=process.argv.includes('--execute');
const s=await session();
try {
  const before=await s.state();
  if(name==='check') {
    console.log(JSON.stringify(summarize(before),null,2));
  } else {
    if(!execute)throw new Error('真实验收动作需要显式 --execute；默认只读取状态');
    if(before.platformBlock)throw new Error('平台已暂停，等待人工恢复');
    if(name==='overview') {
      await s.click('待办'); await s.click('刷新进度和作业');
      const after=await waitFor(s,s=>s.scan.phase!=='running');
      await record(name,after.scan.phase==='done'?'PASS':'FAIL',summarize(after));
    } else if(name==='vision') {
      const since=Date.now();
      await s.click('设置');await s.click('保存并测试视觉连接');
      const after=await waitFor(s,state=>Object.values(state.operations).some(o=>o.kind==='test'&&o.startedAt>=since&&o.phase!=='running'));
      const run=Object.values(after.operations).find(o=>o.kind==='test'&&o.startedAt>=since&&o.phase!=='running');
      await record(name,run.phase==='done'?'PASS':'FAIL',{phase:run.phase,note:safeText(run.note)});
    } else if(['decode','solve','fill','draft','submit'].includes(name)) {
      const workspace=before.workspaces[before.currentPage?.workspaceId];
      if(!authorizedTask(before,workspace?.task))throw new Error('当前页不属于已授权验收任务');
      await s.current();
      const label={decode:'识别文字',solve:'生成参考答案',fill:'填写答案',draft:'保存草稿',submit:'提交答案'}[name];
      const since=Date.now();await s.click(label);
      const after=await waitFor(s,state=>actionFinished(state,workspace.task.id,since,name),600000);
      const workflow=after.workflows[workspace.task.id];
      const status=workflow.phase==='error'?'FAIL':['review','paused','cancelled'].includes(workflow.phase)?'INCOMPLETE':'OBSERVED';
      await record(name,status,summarize(after));
    } else if(name==='pause-learning') {
      await s.click('暂停');await waitFor(s,state=>state.learning.phase!=='running');
      await record(name,'PASS');
    } else throw new Error('未知真实验收用例');
    console.log(JSON.stringify({case:name,report:'artifacts/private/0.5.5-live.json'}));
  }
} catch(error) {
  console.error(safeText(error.message));process.exitCode=1;
}

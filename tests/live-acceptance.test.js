// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { authorizedTask, actionFinished, safeText } from '../scripts/debug/live-session.mjs';

describe('live acceptance boundaries', () => {
  const state={accountId:'a',courses:[{id:'e',title:'合成课程 A'},{id:'c',title:'合成课程 B'},{id:'other',title:'其他合成课程'}]};
  const targets={quizCourse:'合成课程 A',homeworkCourse:'合成课程 B',homeworkTitle:'合成作业'};
  it('permits only the authorized course and the named ordinary homework',()=>{
    expect(authorizedTask(state,{accountId:'a',courseId:'e',type:'quiz'},targets)).toBe(true);
    expect(authorizedTask(state,{accountId:'a',courseId:'c',type:'homework',title:'合成作业'},targets)).toBe(true);
    expect(authorizedTask(state,{accountId:'a',courseId:'c',type:'homework',title:'其他合成作业'},targets)).toBe(false);
    expect(authorizedTask(state,{accountId:'b',courseId:'e',type:'quiz'},targets)).toBe(false);
    expect(authorizedTask(state,{accountId:'a',courseId:'other',type:'quiz'},targets)).toBe(false);
    expect(authorizedTask(state,{accountId:'a',courseId:'e',type:'quiz',analysisOnly:true},targets)).toBe(false);
    expect(authorizedTask(state,{accountId:'a',courseId:'e',type:'quiz'},{...targets,quizCourse:''})).toBe(false);
  });
  it('removes credentials and signed query parameters from error evidence',()=>{
    const text=safeText('error https://mooc1.chaoxing.com/cards?enc=secret&cpi=personal token=private Bearer privatevalue sk-exampleprivate');
    for(const secret of ['secret','personal','privatevalue','sk-exampleprivate'])expect(text).not.toContain(secret);
    expect(text).toContain('/cards');
  });
  it('correlates a reused workflow run to the new step instead of its original start time',()=>{
    const s={workflows:{t:{runId:'r',action:'solve',phase:'waiting-user'}},operations:{r:{startedAt:10,lastProgressAt:150}}};
    expect(actionFinished(s,'t',100,'solve')).toBe(true);
    expect(actionFinished(s,'t',151,'solve')).toBe(false);
    expect(actionFinished(s,'t',100,'fill')).toBe(false);
    s.workflows.t.phase='running';
    expect(actionFinished(s,'t',100,'solve')).toBe(false);
  });
});

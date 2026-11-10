import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { handleFactoryFlow } from './flow-http';
import { acceptanceMarkdown } from './acceptance-report';
import { publicFactoryStage, publicReviewSummary } from './public-flow';
import { AgentProfileError } from './agent-profile-definition';
import { publicFactoryReceipt } from './public-receipt';

test('browser flow approval rejects delegated credentials, cross-origin writes and forged actions before touching SQL', async () => {
  const noDatabase = new Proxy({}, { get() { assert.fail('must not touch the database'); } }) as never;
  const taskId: string = randomUUID(), req = { actor: { userId:'owner',sessionId:'browser' }, authorization:null, method:'POST', taskId,
    origin:'https://app.invalid',url:`https://app.invalid/api/factory/tasks/${taskId}/flow`,body:{operation:'approve_spec',input:{binding:{taskId,revision:1},eventId:randomUUID()}} };
  const call = (patch: Partial<typeof req>) => handleFactoryFlow(noDatabase,noDatabase,noDatabase,{...req,...patch});
  assert.equal((await call({actor:null as never})).status,401);
  assert.equal((await call({authorization:'Bearer delegated' as never})).status,401);
  for (const origin of ['https://other.invalid','null','']) assert.equal((await call({origin})).status,403);
  assert.equal((await call({taskId:'not-a-task'})).status,404);
  assert.equal((await call({method:'DELETE'})).status,405);
  assert.equal((await call({body:{...req.body,operation:'advance'}})).status,422);
  assert.equal((await call({body:{...req.body,input:{...req.body.input,binding:{taskId:randomUUID(),revision:1}}}})).status,422);
});

test('public stages require merge evidence and keep cancellation distinct', () => {
  assert.equal(publicFactoryStage('approval','passed',false),'handoff');
  assert.equal(publicFactoryStage('publish','passed',false),'handoff');
  assert.equal(publicFactoryStage('monitor','passed',false),'handoff');
  assert.equal(publicFactoryStage('publish','passed',true),'completed');
  assert.equal(publicFactoryStage('execute','cancelled',false),'cancelled');
});

test('review summary is a cache projection: no PR is empty and historical fields stay unknown', () => {
  assert.equal(publicReviewSummary(null, 'mikka/mik-1'), null);
  assert.equal(publicReviewSummary({ url: 'https://other.invalid/pull/1' }, null), null);
  const url = 'https://github.com/o/r/pull/1', headSha = 'a'.repeat(40), updatedAt = '2026-11-09T14:00:00Z';
  assert.deepEqual(publicReviewSummary({ url }, 'mikka/mik-1'), { branch: 'mikka/mik-1', additions: null, deletions: null,
    changedFiles: null, headSha: null, checks: null, checksUpdatedAt: null });
  const reviewChecks = { headSha, complete: true, updatedAt, entries: { CI: { id: 1, state: 'passed', at: updatedAt } } };
  assert.deepEqual(publicReviewSummary({ url, branch: 'mikka/mik-2', headSha, additions: 8, deletions: 0, changedFiles: 2, reviewChecks }, null),
    { branch: 'mikka/mik-2', headSha, additions: 8, deletions: 0, changedFiles: 2, checks: { passed: 1, failed: 0, pending: 0, skipped: 0 }, checksUpdatedAt: updatedAt });
  assert.equal(publicReviewSummary({ url, headSha: 'b'.repeat(40), reviewChecks }, null)?.checks, null);
});

test('v2 action receipts keep exact fences and replay metadata without a second task state or a post-commit read', () => {
  const task = { id: randomUUID(), issueId: randomUUID(), attemptId: randomUUID(), candidateId: randomUUID(), revision: 7, route: { flowVersion: 2 }, stage: 'execute', status: 'running' };
  const snapshot = { contractVersion: 1, task, attempts: [{ stage: 'verify', runId: null }], candidates: [{ id: task.candidateId }] };
  const receipt = publicFactoryReceipt(snapshot);
  assert.deepEqual(receipt, { contractVersion: 2, binding: { taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, candidateId: task.candidateId, revision: 7 },
    readTask: { tool: 'get_factory_task', input: { taskId: task.id } } });
  assert.deepEqual(publicFactoryReceipt(structuredClone(snapshot)), receipt, 'an exact action retry presents the same durable receipt');
  const runId = randomUUID();
  for (const replayed of [false, true]) {
    const dispatched = publicFactoryReceipt({ ...snapshot, runId, replayed });
    assert.deepEqual(dispatched, { ...receipt, runId, replayed });
    for (const key of ['task','attempts','candidates','status','route','stage']) assert.equal(key in dispatched, false);
  }
  const legacy = { ...snapshot, task: { ...task, route: {} } };
  assert.equal(publicFactoryReceipt(legacy), legacy, 'v1 remains the same object and contract');
  for (const result of [{ error: 'factoryReplayMismatch' }, { pending: true, reason: 'Evidence unavailable', binding: { taskId: task.id, revision: 7 } }, { proposalId: 'proposal', binding: { taskId: task.id, revision: 7 }, replayed: true, productionEligible: false }])
    assert.equal(publicFactoryReceipt(result), result, 'non-snapshot outcomes keep their original semantics');
});

test('acceptance Markdown keeps unverified reasons first, records resolutions without inventing a pass and stays below the artifact byte limit', () => {
  const source={id:randomUUID(),candidateId:randomUUID(),sha:'a'.repeat(40),author:'Agent',title:'Fixture',locale:'en',pullRequest:{url:'https://github.com/example/fixture/pull/1',additions:2,deletions:1},
    report:{summary:'Actual implementation report',filesChanged:['README.md'],verify:{status:'not_run'},criteria:[
      {text:'Observed criterion',passed:true,status:'passed' as const,evidence:'Observed output',resolution:'Updated the described route.'},
      {text:'Missing criterion',passed:false,status:'unverified' as const,reason:'No executable command exists.'},
    ]}};
  const rendered=acceptanceMarkdown(source,{candidateId:randomUUID(),report:{...source.report,summary:'One earlier review',criteria:[{text:'Observed criterion',passed:false,evidence:'Earlier issue'}]}},[]);
  assert.deepEqual(rendered.counts,{passed:1,failed:0,unverified:1});
  assert.ok(rendered.content.indexOf('Missing criterion') < rendered.content.indexOf('Observed criterion'));
  assert.match(rendered.content,/No executable command exists/); assert.match(rendered.content,/Updated the described route/);
  assert.match(rendered.content,/has not received a second review/); assert.match(rendered.content,/pull\/1\/files/); assert.match(rendered.content,/\+2 \/ −1/);
  const large={...source,report:{...source.report,criteria:Array.from({length:200},(_,index)=>({text:`${index} `+'界'.repeat(1990),passed:false,status:'unverified' as const,
    reason:'界'.repeat(2000),evidence:'界'.repeat(10000),resolution:'界'.repeat(2000),command:'界'.repeat(2000)}))}};
  const largest=acceptanceMarkdown(large,{candidateId:randomUUID(),report:large.report},[]);
  assert.equal(largest.counts.unverified,200);
  assert.ok(Buffer.byteLength(largest.content)<1000000);
  const criterionId=randomUUID(), captureId=randomUUID();
  const escaped={...source,report:{...source.report,criteria:Array.from({length:200},()=>({criterionId,text:'\\'.repeat(2000),passed:false,status:'unverified' as const,
    reason:'\\'.repeat(2000),evidence:'~'.repeat(5000)+'`'.repeat(5000),resolution:'\\'.repeat(2000),command:'~'.repeat(1000)+'`'.repeat(1000)}))}};
  const hostile=acceptanceMarkdown(escaped,{candidateId:randomUUID(),report:escaped.report},[{captureId,kind:'image',url:`https://app.invalid/api/captures/${captureId}`,title:'\\'.repeat(200),criterion:criterionId,runId:source.id}]);
  assert.ok(Buffer.byteLength(hostile.content)<1000000);
  assert.equal(hostile.content.split(`/api/captures/${captureId}`).length-1,1,'duplicate criterion identifiers cannot multiply one capture');

});

test('only the current review can add or change negative observations in the current report', () => {
  const criterionId=randomUUID(),candidateId=randomUUID();
  const source={id:randomUUID(),candidateId,sha:'a'.repeat(40),author:'Agent',title:'Fixture',locale:'en',pullRequest:null,
    report:{summary:'Implemented',filesChanged:[],verify:{status:'passed'},criteria:[{criterionId,text:'End-to-end behavior',passed:true,evidence:'Implementation observed a successful fixture.'}]}};
  const report={...source.report,summary:'One review',criteria:[{criterionId,text:'End-to-end behavior',passed:false,status:'unverified' as const,reason:'Independent observation unavailable.'},
    {text:'Fresh review-only observation',passed:false,status:'unverified' as const,reason:'No environment for the second check.'}]};
  const current=acceptanceMarkdown(source,{candidateId,report},[]);
  assert.deepEqual(current.counts,{passed:0,failed:0,unverified:2});
  assert.ok(current.content.includes('Independent observation unavailable')&&current.content.indexOf('Independent observation unavailable')<current.content.indexOf('## Review'));
  assert.ok(current.content.includes('No environment for the second check')&&current.content.indexOf('No environment for the second check')<current.content.indexOf('## Review'));
  assert.match(current.content,/Implementation reported: Verified/);
  assert.match(current.content,/Implementation observed a successful fixture/);
  const historical=acceptanceMarkdown(source,{candidateId:randomUUID(),report},[]);
  assert.deepEqual(historical.counts,{passed:1,failed:0,unverified:0});
  assert.match(historical.content,/earlier candidate/);
  const judgment=acceptanceMarkdown(source,{candidateId,report:{...report,criteria:[{criterionId,text:'End-to-end behavior',passed:false,status:'failed',evidence:'Observed a mismatch requiring product judgment.'}]}},[]);
  assert.deepEqual(judgment.counts,{passed:0,failed:1,unverified:0});
  assert.match(judgment.content,/Review observation: Failed/);
  const maximum=acceptanceMarkdown({...source,report:{...source.report,criteria:Array.from({length:200},(_,i)=>({text:`Implemented ${i}`,passed:true,evidence:'~'.repeat(5000)+'`'.repeat(5000)}))}},
    {candidateId,report:{...report,criteria:Array.from({length:200},(_,i)=>({text:`Reviewed ${i}`,passed:false,status:'unverified',reason:'\\'.repeat(2000),evidence:'~'.repeat(5000)+'`'.repeat(5000)}))}},[]);
  assert.equal(maximum.counts.unverified,200); assert.equal(maximum.counts.passed,200);
  assert.ok(Buffer.byteLength(maximum.content)<1000000);
});

test('browser spec approval preserves known profile refusal status/code/detail and unknown causes', async () => {
  const noDatabase = new Proxy({}, {get(){assert.fail('must not touch the database');}}) as never;
  const taskId=randomUUID(),cause=new Error('synthetic provider refusal');
  const req={actor:{userId:'owner',sessionId:'browser'},authorization:null,method:'POST',taskId,origin:'https://app.invalid',url:`https://app.invalid/api/factory/tasks/${taskId}/flow`,
    body:{operation:'approve_spec',input:{binding:{taskId,revision:2},eventId:randomUUID()}}};
  const refusal=new AgentProfileError('agentProfileModelUnavailable',409,{detail:'quota',cause});
  assert.deepEqual(await handleFactoryFlow(noDatabase,noDatabase,async()=>{throw refusal;},req),{status:409,body:{error:'agentProfileModelUnavailable',detail:'quota'}});
  assert.equal(refusal.cause,cause);
  const unknown=new Error('original unexpected failure',{cause});
  await assert.rejects(handleFactoryFlow(noDatabase,noDatabase,async()=>{throw unknown;},req),error=>error instanceof Error&&error===unknown&&error.cause===cause);
});


test('acceptance presentation uses the selected locale and retains original observation reasons', () => {
  const candidateId=randomUUID();
  const source={id:randomUUID(),candidateId,sha:null,author:'Agent',title:'Locale fixture',locale:'en',pullRequest:null,
    report:{summary:'Original summary',filesChanged:[],verify:{status:'not_run'},criteria:[]}};
  for (const [locale,expected] of [['en', ['Acceptance observations','The implementation did not record per-criterion observations.','Line counts were not recorded.']],
    ['zh-CN', ['验收观察','实现未记录逐项验收观察。','未记录行数统计。']]] as const) {
    const empty=acceptanceMarkdown({...source,locale},null,[]);
    assert.deepEqual(empty.counts,{passed:0,failed:0,unverified:1});
    for (const text of expected) assert.ok(empty.content.includes(text));
    assert.ok(!empty.content.includes('{status}'));
    const reason='Original observation $& {status}: needs an external environment.';
    const criterion={text:'Observed boundary',passed:false,status:'unverified' as const,reason};
    const observed=acceptanceMarkdown({...source,locale,report:{...source.report,criteria:[criterion]}},{candidateId,report:{...source.report,criteria:[criterion]}},[]);
    assert.ok(observed.content.includes(String.raw`Original observation $& \{status\}: needs an external environment.`));
    assert.deepEqual(observed.counts,{passed:0,failed:0,unverified:1});
  }
});

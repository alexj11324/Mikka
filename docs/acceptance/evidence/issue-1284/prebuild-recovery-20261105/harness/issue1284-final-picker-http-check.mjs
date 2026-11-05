import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const config=JSON.parse(await readFile(process.env.MIKKA_FINAL_CONFIG,'utf8'));
const root=config.root??'/workspace/Mikka',prefix=config.prefix;
assert.match(config.sourceCommit,/^[a-f0-9]{40}$/);assert.match(config.sourceTree,/^[a-f0-9]{40}$/);assert.match(prefix,/^\/tmp\/issue1284-[a-z0-9-]+$/);
process.chdir(root);
const {loadEnvironment,assertDeploymentIdentity}=await import(pathToFileURL(resolve(root,'scripts/test-accounts/environment.mjs')));
const {acquireTestAccounts}=await import(pathToFileURL(resolve(root,'scripts/test-accounts/session.mjs')));
const metadata=JSON.parse(await readFile(prefix+'-state.json','utf8'));
assert.equal(metadata.phase,'ready');
assert.equal(metadata.sourceCommit,config.sourceCommit);assert.equal(metadata.sourceTree,config.sourceTree);
assert.equal(metadata.sourceDirty,false);
assert.equal(metadata.buildCommand,'pnpm build');
const appEnv=Object.fromEntries((await readFile('/proc/'+metadata.appPid+'/environ')).toString().split('\0').filter(x=>x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
for(const key of ['E2E_DATABASE_URL','MIKKA_DATABASE_URL','DATABASE_URL','BETTER_AUTH_URL','E2E_BASE_URL','MIKKA_TEST_DEPLOYMENT_SHA','MIKKA_TEST_ENVIRONMENT_FILE','MIKKA_LOCAL_TEST_ACCOUNTS','BETTER_AUTH_SECRET','RESEND_API_KEY','AI_GATEWAY_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','COMPOSIO_API_KEY','E2B_API_KEY','EXPO_ACCESS_TOKEN','POSTHOG_SECRET_KEY','DEEPSEEK_API_KEY','VERCEL','VERCEL_ENV','CI','GITHUB_ACTIONS','ORVILO_DATABASE_URL']) {
 if(appEnv[key]===undefined)delete process.env[key];else process.env[key]=appEnv[key];
}
const report={kind:'final-normal-http-profile-api',buildCommand:metadata.buildCommand,sourceTree:metadata.sourceTree,sourceCommit:metadata.sourceCommit,sourceDirty:metadata.sourceDirty,sourceDigest:metadata.sourceDigest,origin:metadata.origin,startedAt:new Date().toISOString(),checks:[],passed:false};
let accounts,fixture,visualFixture,pickerFixture,currentStep='attestation';
function mark(name,actual,expected){currentStep=name;report.checks.push({name,actual,expected,passed:actual===expected});assert.equal(actual,expected,name)}
function json(method,body){return {method,headers:{'content-type':'application/json'},body:JSON.stringify(body)}}

const executeFile=promisify(execFile);
async function fixtureStep(mode,workspaceId='',purpose='api') {
 currentStep='isolated fixture '+mode;
 try {
 await executeFile(process.execPath,['--import',resolve(root,'tests/support/server-only.mjs'),'--import','tsx','/tmp/issue1284-final-recovery-fixture.mts',mode,accounts.owner.userId,workspaceId,purpose],{cwd:root,env:process.env,maxBuffer:1024*1024});
 } catch(error) {
  await writeFile(prefix+'-fixture-'+mode+'-'+purpose+'-error-private.log',typeof error.stderr==='string'?error.stderr:'NO_CHILD_STDERR',{mode:0o600});
  throw error;
 }
 return JSON.parse(await readFile(prefix+(purpose==='ui'?'-ui-task-fixture.json':'-task-fixture.json'),'utf8'));
}
async function pickerFixtureStep(mode,workspaceId='') {
 currentStep='isolated picker fixture '+mode;
 try {
  await executeFile(process.execPath,['--import',resolve(root,'tests/support/server-only.mjs'),'--import','tsx','/tmp/issue1284-final-picker-fixture.mts',mode,accounts.owner.userId,workspaceId],{cwd:root,env:process.env,maxBuffer:1024*1024});
 } catch(error) {
  await writeFile(config.prefix+'-picker-'+mode+'-error-private.log',typeof error.stderr==='string'?error.stderr:'NO_CHILD_STDERR',{mode:0o600});
  throw error;
 }
 return JSON.parse(await readFile(config.prefix+'-picker-fixture.json','utf8'));
}
async function rememberPickerProfile(role,profile) {
 pickerFixture={...pickerFixture,[role]:{id:profile.id,name:profile.name,version:profile.version}};
 await writeFile(prefix+'-picker-fixture.json',JSON.stringify(pickerFixture,null,2)+'\n',{mode:0o600});
}
async function holdForScreenshots(state) {
 await writeFile(prefix+'-visual-state.json',JSON.stringify(state,null,2)+'\n',{mode:0o600});
 if(!config.holdForScreenshots)return;
 console.log(JSON.stringify({phase:'ready-for-screenshots',metadataPath:prefix+'-visual-state.json',driverPid:process.pid}));
 await new Promise((resolve,reject)=>{
  const finish=()=>{clearTimeout(timer);unsubscribe();process.removeListener('SIGUSR1',finish);process.removeListener('SIGTERM',finish);resolve();};
  const unsubscribe=accounts.onLeaseLost(()=>{clearTimeout(timer);reject(Error('SCREENSHOT_ACCOUNT_LEASE_LOST'));});
  const timer=setTimeout(()=>{unsubscribe();reject(Error('SCREENSHOT_HOLD_EXPIRED'));},600000);
  process.once('SIGUSR1',finish);process.once('SIGTERM',finish);
 });
}

try {
 const environment=await loadEnvironment();await assertDeploymentIdentity(environment);mark('strict deployment attestation',true,true);
 currentStep='normal register/sign-in and session acquisition';
 accounts=await acquireTestAccounts({environment,runId:'issue1284-profile-http-'+Date.now(),workerId:'profile-api-probe',requestId:randomUUID(),ttlMs:90000});
 for(const role of ['owner','peer']) {
  const response=await accounts[role].request('/api/auth/get-session');mark(role+' session HTTP',response.status,200);
  const session=await response.json();mark(role+' session identity',session.user.id===accounts[role].userId,true);
 }
 const workspaceResponse=await accounts.owner.request('/api/workspace');mark('owner workspace HTTP',workspaceResponse.status,200);
 const {workspace}=await workspaceResponse.json();assert.match(workspace.id,/^[a-f0-9-]{36}$/);
 const peerWorkspaceResponse=await accounts.peer.request('/api/workspace');mark('peer workspace HTTP',peerWorkspaceResponse.status,200);
 const peerWorkspace=(await peerWorkspaceResponse.json()).workspace;
 const path='/api/factory/agent-profiles',query='?workspaceId='+workspace.id;
 const anonymous=await fetch(environment.origin+environment.basePath+path+query,{redirect:'error',headers:{origin:environment.origin},signal:AbortSignal.timeout(10000)});mark('anonymous Profile list refused',anonymous.status,401);await anonymous.body?.cancel();
 const initial=await accounts.owner.request(path+query);mark('authenticated Profile list',initial.status,200);mark('Profile response is private',initial.headers.get('cache-control'),'private, no-store');
 const first=await initial.json();assert.ok(Array.isArray(first.profiles));
 const definition={name:'Isolated HTTP review fixture',description:'Disposable environment API validation',roles:['review'],enabled:false,harness:'codex',model:{mode:'inherit'},effort:'low',instructions:'Synthetic profile instructions for normal HTTP validation.',skills:['independent-review']};
 const created=await accounts.owner.request(path,json('POST',{workspaceId:workspace.id,profile:definition,requestId:randomUUID()}));mark('create Profile via authenticated POST',created.status,201);
 const original=(await created.json()).profile;mark('initial Profile version',original.version,1);assert.match(original.digest,/^[a-f0-9]{64}$/);
 const profilePath=path+'/'+original.id;
 const own=await accounts.owner.request(profilePath+query);mark('read own Profile',own.status,200);mark('saved instructions unchanged',(await own.json()).profile.instructions===definition.instructions,true);
 const foreign=await accounts.peer.request(profilePath+query);mark('peer cannot read owner workspace Profile',foreign.status,404);await foreign.body?.cancel();
 const renamed={...definition,name:'Isolated HTTP review updated',instructions:'Updated synthetic instruction revision.'};
 const updated=await accounts.owner.request(profilePath,json('PATCH',{workspaceId:workspace.id,version:original.version,profile:renamed}));mark('update owned Profile via PATCH',updated.status,200);
 const current=(await updated.json()).profile;mark('updated Profile version',current.version,2);mark('revision changes digest',current.digest!==original.digest,true);
 const stale=await accounts.owner.request(profilePath,json('PATCH',{workspaceId:workspace.id,version:original.version,profile:definition}));mark('stale Profile update rejected',stale.status,409);await stale.body?.cancel();
 const history=await accounts.owner.request(profilePath+query+'&history=1');mark('read Profile history',history.status,200);
 const versions=(await history.json()).versions;mark('immutable revisions retained',versions.length,2);
 const archived=await accounts.owner.request(profilePath,json('DELETE',{workspaceId:workspace.id,version:current.version}));mark('archive owned Profile via DELETE',archived.status,200);mark('archive recorded',Boolean((await archived.json()).profile.archivedAt),true);
 const after=await accounts.owner.request(path+query);mark('list after archive',after.status,200);mark('archived Profile absent from active list',!(await after.json()).profiles.some(p=>p.id===original.id),true);
 const peerList=await accounts.peer.request(path+'?workspaceId='+peerWorkspace.id);mark('peer own workspace remains available',peerList.status,200);mark('peer list isolated',!(await peerList.json()).profiles.some(p=>p.id===original.id),true);

 report.originalProfileAssertions=report.checks.length;assert.equal(report.originalProfileAssertions,27);
 fixture=await fixtureStep('create',workspace.id);
 const taskPath='/api/factory/tasks/'+fixture.taskId;
 const getTask=await accounts.owner.request(taskPath);mark('Owner noRun Task detail HTTP',getTask.status,200);
 const before=await getTask.json();
 mark('Task detail is private',getTask.headers.get('cache-control'),'private, no-store');
 mark('host noRun capability matches current binding',before.checkDispatchRecovery?.binding?.taskId===before.task.id&&before.checkDispatchRecovery.binding.revision===before.task.revision,true);
 mark('frozen Run start capability remains absent',before.checkStartRecovery===undefined,true);
 const currentAttempt=before.attempts.find(a=>a.id===before.task.attemptId);
 mark('blocked check has candidate and no execution',before.task.stage==='review'&&before.task.status==='blocked'&&before.task.candidateId===fixture.candidateId&&currentAttempt?.runId===null&&currentAttempt?.sessionId===null&&before.checks?.some(c=>c.attemptId===before.task.attemptId&&c.candidateId===fixture.candidateId&&c.status==='blocked'&&c.runId===null),true);
 const list=await accounts.owner.request('/api/factory/tasks?issueId='+fixture.issueId);mark('Owner Task list HTTP',list.status,200);
 const listed=(await list.json()).tasks.find(t=>t.id===fixture.taskId);
 mark('list and detail identify the same current attempt',listed?.revision===before.task.revision&&listed?.attemptId===before.task.attemptId&&listed?.candidateId===before.task.candidateId,true);
 const ledgerResponse=await accounts.owner.request(taskPath+'/approval?view=ledger');mark('Owner candidate ledger HTTP',ledgerResponse.status,200);
 const ledger=await ledgerResponse.json();mark('ledger identifies exact Task attempt candidate and revision',ledger.binding?.taskId===before.task.id&&ledger.binding?.issueId===before.task.issueId&&ledger.binding?.attemptId===before.task.attemptId&&ledger.binding?.candidateId===before.task.candidateId&&ledger.binding?.revision===before.task.revision,true);
 const hidden=await accounts.peer.request(taskPath);mark('peer cannot read noRun Task',hidden.status,404);await hidden.body?.cancel();
 const anonymousTask=await fetch(environment.origin+environment.basePath+taskPath,{redirect:'error',headers:{origin:environment.origin},signal:AbortSignal.timeout(10000)});mark('anonymous Task detail refused',anonymousTask.status,401);await anonymousTask.body?.cancel();
 const retryBody={binding:before.checkDispatchRecovery.binding,eventId:randomUUID(),action:'retry',reason:'Retry the independent review'};
 const peerRetry=await accounts.peer.request(taskPath,json('POST',retryBody));mark('peer cannot retry noRun Task',peerRetry.status,404);await peerRetry.body?.cancel();
 const retry=await accounts.owner.request(taskPath,json('POST',retryBody));mark('Owner ordinary retry through Next HTTP',retry.status,200);
 const receipt=await retry.json(),nextAttempt=receipt.attempts.find(a=>a.id===receipt.task.attemptId);
 mark('ordinary retry retains Task and candidate',receipt.task.id===before.task.id&&receipt.task.issueId===before.task.issueId&&receipt.task.candidateId===fixture.candidateId,true);
 mark('noRun retry receipt is pending with revision plus one',receipt.task.stage==='review'&&receipt.task.status==='pending'&&receipt.task.revision===before.task.revision+1&&receipt.task.attemptId!==before.task.attemptId&&nextAttempt?.status==='pending'&&nextAttempt?.runId===null&&nextAttempt?.sessionId===null,true);
 const replay=await accounts.owner.request(taskPath,json('POST',retryBody));mark('retry event replays successfully',replay.status,200);
 const replayValue=await replay.json();mark('retry replay retains the same exact receipt',isDeepStrictEqual(replayValue,receipt),true);
 const staleRetry=await accounts.owner.request(taskPath,json('POST',{...retryBody,eventId:randomUUID()}));mark('stale retry binding rejected',staleRetry.status,409);await staleRetry.body?.cancel();
 const pending=await accounts.owner.request(taskPath);mark('read retried Task HTTP',pending.status,200);
 const pendingValue=await pending.json();mark('pending read clears both recovery hints',pendingValue.checkStartRecovery===undefined&&pendingValue.checkDispatchRecovery===undefined&&pendingValue.task.attemptId===receipt.task.attemptId,true);
 fixture=await fixtureStep('inspect');mark('ordinary HTTP retry creates no additional native Run',fixture.actualRunCount===1&&fixture.activeRunCount===0,true);

 // A second, explicitly visual-only Task stays blocked; the tested HTTP Task
 // remains pending with its original retry receipt and is never rewritten.
 visualFixture=await fixtureStep('create',workspace.id,'ui');
 mark('UI and HTTP fixtures are separate Tasks and Issues',visualFixture.taskId!==fixture.taskId&&visualFixture.issueId!==fixture.issueId,true);
 const visualResponse=await accounts.owner.request('/api/factory/tasks/'+visualFixture.taskId);mark('read independent UI fixture HTTP',visualResponse.status,200);
 const visual=await visualResponse.json();mark('UI fixture is blocked with candidate and noRun recovery',visual.task.candidateId===visualFixture.candidateId&&visual.task.status==='blocked'&&visual.checkDispatchRecovery?.binding?.revision===visual.task.revision&&visual.checkStartRecovery===undefined,true);
 report.syntheticFixtures=[{purpose:'http-contract',taskId:fixture.taskId,issueId:fixture.issueId,candidateId:before.task.candidateId,candidateSha:before.candidates.find(c=>c.id===before.task.candidateId)?.sha,finalStatus:pendingValue.task.status,finalAttemptId:pendingValue.task.attemptId,description:fixture.description},
  {purpose:'visual-only',taskId:visualFixture.taskId,issueId:visualFixture.issueId,candidateId:visual.task.candidateId,candidateSha:visual.candidates.find(c=>c.id===visual.task.candidateId)?.sha,finalStatus:visual.task.status,description:visualFixture.description}];
 assert.equal(report.checks.length,51,'original normal HTTP contract assertions remain intact');
 report.originalRecoveryAssertions=24;
 pickerFixture=await pickerFixtureStep('seed',workspace.id);
 const pickerBase={description:'Disposable normal-page screenshot fixture; no model execution requested.',roles:['execute','frontend'],harness:'claude_code',model:{mode:'inherit'},instructions:'Synthetic display-only fixture.',skills:[]};
 const checkingCreated=await accounts.owner.request(path,json('POST',{workspaceId:workspace.id,profile:{...pickerBase,name:'待检查 · 隔离演示',enabled:true},requestId:randomUUID()}));
 mark('create checking screenshot Profile through normal HTTP',checkingCreated.status,201);
 const checkingProfile=(await checkingCreated.json()).profile;
 await rememberPickerProfile('checkingProfile',checkingProfile);
 const disabledCreated=await accounts.owner.request(path,json('POST',{workspaceId:workspace.id,profile:{...pickerBase,name:'已停用 · 隔离演示',enabled:false},requestId:randomUUID()}));
 mark('create disabled screenshot Profile through normal HTTP',disabledCreated.status,201);
 const disabledProfile=(await disabledCreated.json()).profile;
 await rememberPickerProfile('disabledProfile',disabledProfile);
 const unavailableCreated=await accounts.owner.request(path,json('POST',{workspaceId:workspace.id,profile:{...pickerBase,name:'暂无模型来源 · 隔离演示',harness:'codex',enabled:true},requestId:randomUUID()}));
 mark('create enabled unavailable screenshot Profile through normal HTTP',unavailableCreated.status,201);
 const unavailableProfile=(await unavailableCreated.json()).profile;
 await rememberPickerProfile('unavailableProfile',unavailableProfile);
 const pickerResponse=await accounts.owner.request(path+query);mark('normal Profile management GET for picker fixture',pickerResponse.status,200);
 const pickerView=await pickerResponse.json();
 mark('normal GET reports enabled Profile allowance as checking',pickerView.profiles.some(p=>p.id===checkingProfile.id&&p.enabled&&!p.archivedAt)&&pickerView.availability[checkingProfile.id]?.available===false&&pickerView.availability[checkingProfile.id]?.reason==='checking',true);
 mark('normal GET keeps disabled Profile authoritatively unavailable',pickerView.profiles.some(p=>p.id===disabledProfile.id&&!p.enabled)&&pickerView.availability[disabledProfile.id]?.available===false&&pickerView.availability[disabledProfile.id]?.reason==='disabled',true);
 mark('normal GET reports enabled Codex Profile without a model source',pickerView.profiles.some(p=>p.id===unavailableProfile.id&&p.enabled&&!p.archivedAt)&&pickerView.availability[unavailableProfile.id]?.available===false&&pickerView.availability[unavailableProfile.id]?.reason==='noModels',true);
 mark('normal GET keeps Default allowance checking distinct from available',pickerView.defaultAvailability?.available===false&&pickerView.defaultAvailability?.reason==='checking',true);
 const pickerPeer=await accounts.peer.request(path+'?workspaceId='+peerWorkspace.id);const peerPickerView=await pickerPeer.json();
 mark('peer cannot see owner screenshot Profiles',pickerPeer.status===200&&!peerPickerView.profiles.some(p=>[checkingProfile.id,disabledProfile.id,unavailableProfile.id].includes(p.id)),true);
 report.pickerFixture={checkingProfile:pickerFixture.checkingProfile,disabledProfile:pickerFixture.disabledProfile,unavailableProfile:pickerFixture.unavailableProfile,availability:{checking:pickerView.availability[checkingProfile.id],disabled:pickerView.availability[disabledProfile.id],unavailable:pickerView.availability[unavailableProfile.id],default:pickerView.defaultAvailability},purpose:'Normal GET-backed New Task selection display; no Send, dispatch, provider or native-model request.'};
 report.nativeModelRequests=0;
 await holdForScreenshots({origin:environment.origin,basePath:environment.basePath,sourceCommit:config.sourceCommit,sourceTree:config.sourceTree,
   issueId:visualFixture.issueId,taskId:visualFixture.taskId,candidateId:visual.task.candidateId,candidateSha:visual.candidates.find(c=>c.id===visual.task.candidateId)?.sha,botId:visualFixture.botId,userId:accounts.owner.userId,statePath:accounts.owner.storageStatePath,
   httpTaskId:fixture.taskId,httpIssueId:fixture.issueId,purpose:'visual-only',description:visualFixture.description,workspaceId:workspace.id,pickerFixture:report.pickerFixture,
   driverPid:process.pid,phase:'ready-for-screenshots',createdAt:new Date().toISOString()});

 const inspectedPicker=await pickerFixtureStep('inspect');mark('picker screenshot preparation creates no additional Run',inspectedPicker.runCount===inspectedPicker.beforeRunCount&&inspectedPicker.activeRunCount===0,true);
 report.passed=true;
} catch(error) {
 report.failure={step:currentStep,code:typeof error.code==='string'?error.code:error.name};process.exitCode=1;
} finally {
 if(accounts){
  report.fixtureCleanup=[];
  for(const purpose of ['api','ui'])try {
   const existing=JSON.parse(await readFile(prefix+(purpose==='ui'?'-ui-task-fixture.json':'-task-fixture.json'),'utf8'));
   if(existing.ownerId!==accounts.owner.userId)throw Error('FIXTURE_OWNER_MISMATCH');
   const cleaned=await fixtureStep('cleanup','',purpose);
   report.fixtureCleanup.push({purpose:cleaned.purpose,taskId:cleaned.taskId,issueId:cleaned.issueId,remainingIssues:cleaned.remainingIssues,remainingTasks:cleaned.remainingTasks,remainingRuns:cleaned.remainingRuns,at:cleaned.cleanedAt});
  }catch(error){if(error.code!=='ENOENT'){report.passed=false;report.fixtureCleanupError=error.code??error.name;process.exitCode=1;}}
 }
 if(accounts)try {
  let stored;
  try {stored=JSON.parse(await readFile(prefix+'-picker-fixture.json','utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(stored||pickerFixture) {
  for(const value of [stored,pickerFixture].filter(Boolean)) {
   assert.equal(value.ownerId,accounts.owner.userId,'PICKER_FIXTURE_OWNER_MISMATCH');
   assert.equal(value.sourceCommit,config.sourceCommit,'PICKER_FIXTURE_SOURCE_MISMATCH');
   assert.equal(value.sourceTree,config.sourceTree,'PICKER_FIXTURE_TREE_MISMATCH');
  }
  pickerFixture={...stored,...pickerFixture};
  const archived=[];
  for(const role of ['checkingProfile','disabledProfile','unavailableProfile'])if(pickerFixture[role]){
   const p=pickerFixture[role];
   const response=await accounts.owner.request('/api/factory/agent-profiles/'+p.id,json('DELETE',{workspaceId:pickerFixture.workspaceId,version:p.version}));
   if(response.status!==200)throw Error('PICKER_PROFILE_ARCHIVE_FAILED');
   const value=await response.json();if(!value.profile?.archivedAt)throw Error('PICKER_PROFILE_ARCHIVE_MISSING');archived.push(p.id);
  }
  report.archivedPickerProfiles=archived;
  const cleaned=await pickerFixtureStep('cleanup');
  report.pickerCleanup={connections:cleaned.remainingConnections,bindings:cleaned.remainingBindings,devices:cleaned.remainingDevices,at:cleaned.cleanedAt};
  if(cleaned.remainingConnections!==0||cleaned.remainingBindings!==0||cleaned.remainingDevices!==0)throw Error('PICKER_FIXTURE_CLEANUP_INCOMPLETE');
  }
 }catch(error){report.passed=false;report.pickerCleanupError=error.code??error.name;process.exitCode=1;}
 if(accounts)try {const lease=await accounts.release({outcome:'dirty'});report.leaseReleased=true;report.leaseState=lease.state;}catch(error){report.leaseReleased=false;report.releaseCode=error.code??error.name;report.passed=false;process.exitCode=1;}
 if(accounts){
  const require=createRequire(resolve(root,'package.json')), {Pool}=require('pg');
  const cleanupPool=new Pool({connectionString:process.env.E2E_DATABASE_URL,max:1});
  try { report.validSessions=(await cleanupPool.query('SELECT count(*)::int AS n FROM session WHERE "userId"=ANY($1::text[]) AND "expiresAt">clock_timestamp()',[[accounts.owner.userId,accounts.peer.userId]])).rows[0].n;if(report.validSessions!==0){report.passed=false;process.exitCode=1;} }
  finally {await cleanupPool.end();}
 }
 report.totalAssertions=report.checks.length;report.passedAssertions=report.checks.filter(c=>c.passed).length;
 report.finishedAt=new Date().toISOString();
 await writeFile(prefix+'-http-result.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(report));
}

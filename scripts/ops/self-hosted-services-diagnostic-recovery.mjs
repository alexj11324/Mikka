// Zero-model diagnosis and exact recovery of the previous owned fixture only.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const previousRun = '42568213173', base = 'afd42554f3284e815c81413a2084d0c85f038bfb'
const originalServer = '15b0c712-dbe1-4dda-b535-f4c65315349e', directBot = '2718182a-813d-4c0d-96d1-35c826830633'
const prefix = 'ops: inspect private cloud production subscriptions final services diagnostic recovery corrected'
const fixtureName = '测试1567 empty wallet ' + previousRun
const need = (ok, code) => { if (!ok) throw Error('RECOVERY_' + code) }
const hash = s => createHash('sha256').update(s).digest('hex').slice(0,16)
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
const codes = ['cloud_quota_exhausted','cloud_not_connected','cloud_scope_missing','cloud_server_revoked','cloud_invalid_request','cloud_rate_limited','cloud_access_denied','cloud_unavailable','verification_required','points_exhausted','free_allowance_used','platform_paused','usage_in_progress','usage_cost_unavailable','usage_concurrency_limit','provider','modelUnavailable','invalidModel']
const report = { schema: 1, previousRun, startedAt: new Date().toISOString(), status: 'failed', modelRequests: 0, virtualMachines: 0, http: [], cleanup: {} }
let client,pool,owner,originalWorkspace
try {
 const e=process.env, event=JSON.parse(await readFile(e.GITHUB_EVENT_PATH,'utf8'))
 need(e.GITHUB_ACTIONS==='true'&&e.GITHUB_EVENT_NAME==='push'&&e.GITHUB_ACTOR==='alexj11324'&&e.GITHUB_RUN_ATTEMPT==='1'&&e.GITHUB_REPOSITORY==='alexj11324/Mikka'
   &&e.GITHUB_REPOSITORY_ID==='1427517699'&&e.GITHUB_REPOSITORY_OWNER_ID==='183887963'&&e.GITHUB_REF==='refs/heads/ops/infisical-cloud-capabilities','EXECUTION')
 need(event.after===e.GITHUB_SHA&&!event.deleted&&!event.forced&&event.head_commit?.message?.startsWith(prefix)&&event.repository?.id===1427517699&&event.repository.owner?.id===183887963&&!event.repository.fork,'EVENT')
 need(git('rev-parse','HEAD')===e.GITHUB_SHA&&git('rev-parse','HEAD^')===base&&git('diff','--name-only','HEAD^','HEAD').split('\n').sort().join('\n')===['.github/workflows/infisical-cloud-capabilities.yml','scripts/ops/self-hosted-services-diagnostic-recovery.mjs'].join('\n'),'SOURCE')
 report.driver={head:e.GITHUB_SHA,parent:base,run:e.GITHUB_RUN_ID}
 if(e.MIKKA_RECOVERY_PREFLIGHT==='1'){console.log(JSON.stringify({preflight:'passed',...report.driver}));process.exit(0)}
 need(/^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(e.SMOKE_OWNER_EMAIL??'')&&e.SMOKE_OWNER_PASSWORD,'ACCOUNT')
 const source=e.RUNNER_TEMP+'/mikka-services-source'
 const {createSessionClient}=await import(pathToFileURL(source+'/scripts/acceptance/cloud-startup.mjs'))
 const {Pool}=createRequire(source+'/package.json')('pg')
 client=createSessionClient('https://app.aspectlylabs.com',async(url,init)=>{const r=await fetch(url,{...init,redirect:'manual'});report.http.push({path:new URL(url).pathname,status:r.status});return r})
 await client.json('/api/auth/sign-in/email',post({email:e.SMOKE_OWNER_EMAIL,password:e.SMOKE_OWNER_PASSWORD}))
 const identity=await client.json('/api/auth/get-session?disableCookieCache=true');need(identity.user?.email?.toLowerCase()===e.SMOKE_OWNER_EMAIL.toLowerCase(),'IDENTITY');owner=identity.user.id
 const context=await client.json('/api/workspace');need(context.currentUserId===owner,'CONTEXT');originalWorkspace=context.workspace.id
 const current=await client.json('/api/workspace');const fixtures=current.choices.filter(w=>w.name===fixtureName)
 need(fixtures.length<=1,'FIXTURE_AMBIGUOUS')
 if(fixtures.length){
  const id=fixtures[0].id,details=await client.json('/api/workspace?workspace='+id)
  const general=await client.json('/api/settings/workspace-general?workspace='+id)
  need(details.currentUserId===owner&&details.workspace?.id===id&&details.workspace?.name===fixtureName&&details.workspace?.kind==='team'
    &&details.role==='admin'&&general.id===id&&general.canTransfer===true&&general.personal===false,'FIXTURE_OWNER')
  const credit=await client.json('/api/settings/credit-billing?workspace='+id)
  report.ownedEmptyWorkspace={hash:hash(id),zero:credit.balancePoints===0,activeMembers:details.members.filter(m=>m.status==='active').length,
    pendingInvitations:details.invitations.filter(i=>i.status==='pending'&&Date.parse(i.expiresAt)>Date.now()).length,explicitShares:null}
  await client.rpc('workspace.switchWorkspace',[id])
  await client.rpc('workspace-settings.deleteWorkspace',[id,fixtureName])
  const after=await client.json('/api/workspace');need(!after.choices.some(w=>w.id===id),'DELETE_READBACK');report.cleanup.emptyWorkspaceDeleted=true
 } else report.cleanup.emptyWorkspaceAbsent=true
 // Diagnostics cannot prevent exact fixture cleanup above.
 let diagnosticsComplete=true
 try {
  let databaseUrl;try{databaseUrl=new URL(e.MIKKA_DATABASE_URL)}catch{}
  report.databaseConfiguration={provided:typeof e.MIKKA_DATABASE_URL==='string'&&e.MIKKA_DATABASE_URL.length>0,postgresUrl:['postgres:','postgresql:'].includes(databaseUrl?.protocol),unresolvedReference:/\$\{/.test(e.MIKKA_DATABASE_URL??'')}
  need(report.databaseConfiguration.provided&&report.databaseConfiguration.postgresUrl&&!report.databaseConfiguration.unresolvedReference,'DATABASE_CONFIGURATION')
  pool=new Pool({connectionString:e.MIKKA_DATABASE_URL,max:1,ssl:{rejectUnauthorized:true},options:'-c default_transaction_read_only=on -c statement_timeout=5000'})
  const calls=(await pool.query(`SELECT c.model,c.credential_kind,c.usage_id IS NOT NULL AS linked,c.payer_workspace_id IS NOT NULL AS payer,
   c.completed_at IS NOT NULL AS completed,u.state,u."inputTokens",u."outputTokens",u."costMicroUsd",u."generationId" IS NOT NULL AS generation
   FROM cloud.model_calls c LEFT JOIN public.hosted_usage u ON u.id=c.usage_id WHERE c.server_id=$1 ORDER BY c.created_at LIMIT 15`,[originalServer])).rows
  need(calls.length<15,'LEDGER_BOUND')
  report.originalCloudCalls=calls.map(c=>({model:/^[a-zA-Z0-9/_.:-]{1,120}$/.test(c.model)?c.model:'OTHER',credentialKind:c.credential_kind,linked:c.linked,payer:c.payer,
   completed:c.completed,state:c.state,inputTokens:c.inputTokens===null?null:Number(c.inputTokens),outputTokens:c.outputTokens===null?null:Number(c.outputTokens),costMicroUsd:c.costMicroUsd===null?null:Number(c.costMicroUsd),generation:c.generation}))
 }catch(error){diagnosticsComplete=false;report.ledgerDiagnostic={status:'failed',code:/^RECOVERY_[A-Z0-9_]+$/.test(error?.message??'')?error.message:null,sqlstate:/^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:null,
   errorClass:['Error','TypeError','DatabaseError'].includes(error?.name)?error.name:'OTHER',transportCode:['ENOTFOUND','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ERR_INVALID_URL','SELF_SIGNED_CERT_IN_CHAIN'].includes(error?.code)?error.code:null}}
 try {
  const selected=context.choices.filter(w=>hash(w.id)==='a38307f75620de4b'&&w.kind==='team');need(selected.length===1,'ORIGINAL_BOT_WORKSPACE')
  await client.rpc('workspace.switchWorkspace',[selected[0].id])
  const bot=await client.json('/api/bots/'+directBot);need(bot.id===directBot&&bot.name==='测试1567 direct '+previousRun,'BOT_SCOPE')
  const cr=await client.request('/api/mobile/chat?bot='+directBot);need(cr.ok,'CHAT_READ');const chat=await cr.json()
  const failure=JSON.stringify({error:chat.error,failure:chat.failure,cause:chat.cause})
  report.directChat={bot:directBot,working:chat.working===true,enabled:chat.enabled!==false,personItems:chat.items?.filter(i=>i.from==='person').length??0,
   coordinatorItems:chat.items?.filter(i=>i.from==='coordinator').length??0,knownCodes:codes.filter(c=>failure.includes(c)),hasFailure:Boolean(chat.error||chat.failure),
   quotaWords:/insufficient|credit|balance|quota/i.test(failure),authenticationWords:/unauthoriz|authentication|invalid.{0,20}api.{0,10}key/i.test(failure),
   protocolWords:/unsupported|invalid.{0,20}parameter|max_tokens|invalid.{0,20}model/i.test(failure),transientWords:/overload|temporar|rate.?limit|timeout|deadline|502|503|504/i.test(failure)}
  const mr=await client.request('/api/mobile/model?bot='+directBot);need(mr.ok,'MODEL_READ');const menu=await mr.json()
  report.directMenu={kind:menu.current?.kind??null,modelId:menu.current?.modelId??null,hostedSource:menu.current?.hostedSource??null,available:menu.current?.available===true,chosen:menu.current?.chosen===true}
 }catch(error){diagnosticsComplete=false;report.botDiagnostic={status:'failed',code:/^(RECOVERY_[A-Z0-9_]+|startup_[a-z0-9_]+)$/.test(error?.message??'')?error.message:'RECOVERY_BOT_FAILED'}}
 report.status=diagnosticsComplete?'diagnosed_and_recovered':'recovered_diagnostics_partial'
}catch(error){report.code=/^(RECOVERY_[A-Z0-9_]+|startup_[a-z0-9_]+)$/.test(error?.message??'')?error.message:'RECOVERY_FAILED';process.exitCode=1;if(process.env.MIKKA_RECOVERY_PREFLIGHT==='1')console.log(JSON.stringify({preflight:'failed',code:report.code}))}
finally{
 if(client&&originalWorkspace){try{await client.rpc('workspace.switchWorkspace',[originalWorkspace]);const c=await client.json('/api/workspace');need(c.currentUserId===owner&&c.workspace.id===originalWorkspace,'RESTORE');report.cleanup.workspaceRestored=true}catch{report.cleanup.workspaceRestored=false}}
 if(client){try{await client.json('/api/auth/sign-out',post({}));report.cleanup.signedOut=true}catch{report.cleanup.signedOut=false}}
 try{await pool?.end()}catch{report.cleanup.databaseClosed=false}
 if(Object.values(report.cleanup).some(v=>v===false)){report.status='failed';process.exitCode=1}
 report.finishedAt=new Date().toISOString()
 if(process.env.MIKKA_RECOVERY_PREFLIGHT!=='1'){await mkdir('artifacts',{recursive:true});await writeFile('artifacts/self-hosted-services-diagnostic-recovery.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))}
}

import { randomBytes } from 'node:crypto'
import { readFile, appendFile } from 'node:fs/promises'
import { execFileSync,execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { login } from './infisical-cloud-capabilities.mjs'
import { businessAcceptance, acceptanceCode } from './self-hosting-cloud-acceptance.mjs'
export const TARGET = { base: '869729103ac713c107404c0a175f56ada2884255', repo: 'alexj11324/Mikka', ref: 'refs/heads/ops/infisical-cloud-capabilities', project:'89850d6a-f020-4936-863e-df77380dfe40', connection:'d5107d5c-fc41-4f42-a5b1-b77858811bdf', team:'team_C7lwxVVvnUicFli6112mvxpv', app:'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc', publicApp:'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', path:'/mikka-cloud-production' }
const owned=['.github/workflows/infisical-cloud-capabilities.yml','scripts/ops/self-hosting-release.mjs','scripts/ops/self-hosting-release.test.mjs','scripts/ops/self-hosting-cloud-acceptance.mjs']
export function assertExecution(env,event,head,parent,changed) {
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==TARGET.repo||env.GITHUB_REPOSITORY_ID!=='1427517699'||env.GITHUB_REPOSITORY_OWNER_ID!=='183887963'||env.GITHUB_ACTOR!=='alexj11324'||env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_REF!==TARGET.ref||event.repository?.full_name!==TARGET.repo||event.ref!==TARGET.ref||event.after!==head||env.GITHUB_SHA!==head||event.forced||parent!==TARGET.base||changed.length!==owned.length||changed.some(p=>!owned.includes(p))) throw Error('EXECUTION_SCOPE')
}
export function reference(path,key) { if(!/^\/[a-zA-Z0-9/_-]+$/.test(path)||!/^\w+$/.test(key))throw Error('REFERENCE_SCOPE');return '${prod.'+path.slice(1).replaceAll('/','.')+'.'+key+'}' }
export const REQUIRED={BETTER_AUTH_SECRET:'/vercel',MIKKA_DATABASE_URL:'/vercel',DATABASE_URL:'/neon',DATABASE_URL_UNPOOLED:'/neon',EXPO_ACCESS_TOKEN:'/platform',GITHUB_APP_ID:'/github',GITHUB_APP_PRIVATE_KEY:'/github',GITHUB_WEBHOOK_SECRET:'/github',GITHUB_CLIENT_ID:'/vercel',GITHUB_CLIENT_SECRET:'/vercel',WORKSPACE_SECRETS_KEY:'/vercel'}
const OPTIONAL=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','BETTER_AUTH_OAUTH_PROXY_URL','BETTER_AUTH_OAUTH_PROXY_SECRET','LINEAR_TOKEN_ENCRYPTION_KEY','OPENCODE_API_KEY','ZEROCAT_API_KEY','ZEROCAT_BASE_URL','DECISION_GATEWAY_API_KEY']
const constants={MIKKA_EDITION:'cloud',MIKKA_CLOUD_URL:'https://app.aspectlylabs.com/mikka/cloud',BETTER_AUTH_URL:'https://app.aspectlylabs.com',MIKKA_BASE_PATH:'/mikka',GITHUB_APP_SLUG:'mikka-github'}
function demand(v,code){if(!v)throw Error(code)}
export function secretPlan(rows) {
 demand(Array.isArray(rows)&&rows.length<3000,'SECRET_METADATA_SCHEMA')
 const exists=(p,k)=>rows.some(r=>r.secretPath===p&&r.secretKey===k)
 const plan={...constants}
 for(const [key,path] of Object.entries(REQUIRED)){const sourceKey=key==='EXPO_ACCESS_TOKEN'?'EXPO_TOKEN':key;demand(exists(path,sourceKey),'SOURCE_REQUIRED_'+key);plan[key]=reference(path,sourceKey)}
 for(const key of OPTIONAL)if(exists('/vercel',key))plan[key]=reference('/vercel',key)
 const keys=rows.filter(r=>r.secretKey==='MIKKA_CLOUD_DATA_KEY');demand(keys.length<=1,'DATA_KEY_AMBIGUOUS')
 if(keys.length&&keys[0].secretPath!==TARGET.path)plan.MIKKA_CLOUD_DATA_KEY=reference(keys[0].secretPath,'MIKKA_CLOUD_DATA_KEY')
 else if(!keys.length)plan.MIKKA_CLOUD_DATA_KEY=randomBytes(32).toString('base64')
 return plan
}
export function syncBody(){return {name:'mikka-cloud-production',projectId:TARGET.project,connectionId:TARGET.connection,environment:'prod',secretPath:TARGET.path,isAutoSyncEnabled:true,syncOptions:{initialSyncBehavior:'overwrite-destination',disableSecretDeletion:true,includeAllSubFolders:false},destinationConfig:{scope:'project',app:TARGET.app,appName:'mikka-cloud',env:'production',teamId:TARGET.team,sensitive:true}}}
export async function prepare({env=process.env,fetcher=fetch,report}) {
 const token=await login(env,report.requests,fetcher)
 const request=async(origin,path,method='GET',body)=>{
  demand(['https://app.infisical.com','https://api.vercel.com'].includes(origin),'ORIGIN')
  const auth=origin.includes('infisical')?token:env.VERCEL_TEAM_TOKEN;demand(auth,'AUTH_MISSING')
  let r;try{r=await fetcher(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{authorization:'Bearer '+auth,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})}catch{throw Error('API_TRANSPORT')}
  report.requests.push({host:origin.includes('infisical')?'infisical':'vercel',method,path:path.split('?')[0].replace(/\/secrets\/[^/]+$/,'/secrets/[name]'),status:r.status})
  if(!r.ok){let e={};try{e=await r.json()}catch{};const text=String(e.message??'');report.apiFailure={status:r.status,code:typeof e.error==='string'&&/^[A-Za-z _-]{1,60}$/.test(e.error)?e.error:'OTHER',planLimit:/plan|limit|upgrade/i.test(text),permission:/permission|forbidden|access|privilege/i.test(text),notFound:/not found|could not find/i.test(text),validation:/validation|invalid|schema|expected|recogniz/i.test(text),detailsKeys:e.details&&typeof e.details==='object'?Object.keys(e.details).filter(x=>/^[A-Za-z0-9_-]{1,60}$/.test(x)):[]};throw Error('API_HTTP_'+r.status)}return r.status===204?{}:r.json()
 }
 const inf=(p,m,b)=>request('https://app.infisical.com',p,m,b)
 const ver=(p,m,b)=>request('https://api.vercel.com',p,m,b)
 const p=await ver('/v9/projects/'+TARGET.app+'?teamId='+TARGET.team);demand(p.id===TARGET.app&&p.accountId===TARGET.team&&p.name==='mikka-cloud','VERCEL_TARGET')
 const inventory=await inf('/api/v4/secrets?'+new URLSearchParams({projectId:TARGET.project,environment:'prod',secretPath:'/',recursive:'true',viewSecretValue:'false',expandSecretReferences:'false',includeImports:'false'}));const rows=inventory.secrets
 report.platformCredentialNames=rows.filter(r=>r.secretPath==='/platform').map(r=>r.secretKey);report.databaseSourceMetadata=rows.filter(r=>['DATABASE_URL','DATABASE_URL_UNPOOLED','EXPO_ACCESS_TOKEN'].includes(r.secretKey)).map(r=>({name:r.secretKey,path:r.secretPath}));const plan=secretPlan(rows)
 const syncs=await inf('/api/v1/secret-syncs/vercel?projectId='+TARGET.project);demand(Array.isArray(syncs.secretSyncs),'SYNC_SCHEMA')
 for(const s of syncs.secretSyncs){const source=s.folder?.path;if(s.environment?.slug==='prod'&&s.syncOptions?.includeAllSubFolders&&source==='/'&&s.destinationConfig?.app!==TARGET.app)throw Error('PRIVATE_SOURCE_WOULD_LEAK')}
 const folders=await inf('/api/v2/folders?'+new URLSearchParams({projectId:TARGET.project,environment:'prod',path:'/',recursive:'true'}));demand(Array.isArray(folders.folders),'FOLDER_SCHEMA')
 if(!folders.folders.some(f=>f.relativePath===TARGET.path||f.path===TARGET.path)){await inf('/api/v2/folders','POST',{projectId:TARGET.project,environment:'prod',name:'mikka-cloud-production',path:'/'});report.folderCreated=true}
 report.createdKeys=[];report.retainedKeys=[]
 for(const [name,value] of Object.entries(plan)){
  if(rows.some(r=>r.secretPath===TARGET.path&&r.secretKey===name)){report.retainedKeys.push(name);continue}
  await inf('/api/v4/secrets/'+name,'POST',{projectId:TARGET.project,environment:'prod',secretPath:TARGET.path,secretValue:value,type:'shared'});report.createdKeys.push(name)
 }
 report.dataKeyPersistedBeforeSync=true
 const existing=syncs.secretSyncs.filter(s=>s.destinationConfig?.app===TARGET.app&&s.destinationConfig?.env==='production');demand(existing.length<=1,'SYNC_AMBIGUOUS')
 if(!existing.length){
 const available=await inf('/api/v1/app-connections/vercel/available?projectId='+TARGET.project);demand(available.appConnections?.some(c=>c.id===TARGET.connection&&c.name==='mikka-team-vercel-native-sync'),'CONNECTION_NOT_AVAILABLE')

  const retired=syncs.secretSyncs.filter(s=>s.name==='mikka-vercel-skill-acceptance'&&s.destinationConfig?.app===TARGET.publicApp&&s.destinationConfig?.env==='preview'&&s.destinationConfig?.branch==='codex/self-improvement-acceptance-20261026');demand(retired.length===1,'RETIRED_SYNC_NOT_EXACT')
  const prResponse=await fetcher('https://api.github.com/repos/alexj11324/Mikka/pulls/316',{headers:{accept:'application/vnd.github+json',...(env.GITHUB_TOKEN?{authorization:'Bearer '+env.GITHUB_TOKEN}:{})},redirect:'error',signal:AbortSignal.timeout(15000)});demand(prResponse.ok,'RETIRED_PR_HTTP');const pr=await prResponse.json();demand(pr.state==='closed'&&pr.head?.ref==='codex/self-improvement-acceptance-20261026','RETIRED_PR_ACTIVE')
  const body=syncBody();delete body.projectId
  const updated=await inf('/api/v1/secret-syncs/vercel/'+retired[0].id,'PATCH',body);report.syncId=updated.secretSync?.id;report.retiredPreviewSyncReused=true;report.retiredPullRequest=316;report.existingProductionSyncsUnchanged=true
 }

 else {const s=existing[0];demand(s.connection?.id===TARGET.connection&&s.folder?.path===TARGET.path&&s.environment?.slug==='prod'&&s.syncOptions?.disableSecretDeletion===true&&!s.syncOptions?.includeAllSubFolders,'SYNC_SCOPE');report.syncId=s.id}
 demand(typeof report.syncId==='string','SYNC_CREATE_SCHEMA')
 report.result='source_and_sync_prepared';report.connectionConnectRequired=existing.length===0;report.syncStatusMetadata=(syncs.secretSyncs.find(s=>s.id===report.syncId)?{syncStatus:syncs.secretSyncs.find(s=>s.id===report.syncId).syncStatus??null,lastSyncJobStatus:syncs.secretSyncs.find(s=>s.id===report.syncId).lastSyncJobStatus??null}:null)
 // Provider-owned metadata only: locate the existing Neon connection on the public project.
 const publicEnv=await ver('/v10/projects/'+TARGET.publicApp+'/env?teamId='+TARGET.team+'&decrypt=false');demand(Array.isArray(publicEnv.envs),'PUBLIC_METADATA_SCHEMA')
 report.neonVariables=publicEnv.envs.filter(x=>['DATABASE_URL','DATABASE_URL_UNPOOLED'].includes(x.key)&&x.target?.includes('production')&&!x.gitBranch).map(x=>({name:x.key,configurationId:x.configurationId??null,contentHint:x.contentHint??null,system:!!x.system}))
 // Verify the historical Neon snapshots against the live provider-owned source inside this runner.
 report.applicationSecretValuesRequested=true;report.secretValuesRemainInRunner=true;report.neonSnapshotChecks=[];report.refreshedPrivateDatabaseKeys=[]
 for(const key of ['DATABASE_URL','DATABASE_URL_UNPOOLED']) {
  const meta=publicEnv.envs.filter(x=>x.key===key&&x.target?.includes('production')&&!x.gitBranch);demand(meta.length===1&&typeof meta[0].id==='string'&&/^[A-Za-z0-9_]{5,100}$/.test(meta[0].id)&&!!meta[0].configurationId,'NEON_LIVE_SOURCE_SCOPE')
  const live=await ver('/v1/projects/'+TARGET.publicApp+'/env/'+meta[0].id+'?teamId='+TARGET.team);demand(live.key===key&&typeof live.value==='string','NEON_LIVE_VALUE_SCHEMA');let uri;try{uri=new URL(live.value)}catch{throw Error('NEON_LIVE_URL')};demand(['postgres:','postgresql:'].includes(uri.protocol)&&uri.hostname.endsWith('.neon.tech')&&!uri.hash,'NEON_LIVE_URL')
  const privateSecret=await inf('/api/v4/secrets/'+key+'?'+new URLSearchParams({projectId:TARGET.project,environment:'prod',secretPath:TARGET.path,expandSecretReferences:'true',includeImports:'false'}));demand(privateSecret.secret?.secretKey===key&&typeof privateSecret.secret.secretValue==='string','NEON_PRIVATE_SOURCE_SCOPE');const matches=privateSecret.secret.secretValue===live.value;report.neonSnapshotChecks.push({name:key,matchesLiveProvider:matches})
  if(!matches){await inf('/api/v4/secrets/'+key,'PATCH',{projectId:TARGET.project,environment:'prod',secretPath:TARGET.path,secretValue:live.value,type:'shared'});report.refreshedPrivateDatabaseKeys.push(key)}
 }

 report.privateVariableNames=(await ver('/v10/projects/'+TARGET.app+'/env?teamId='+TARGET.team+'&decrypt=false')).envs.filter(x=>x.target?.includes('production')).map(x=>x.key)
 const installations=await ver('/v1/integrations/configurations?view=account&teamId='+TARGET.team)
 report.integrationMetadata=(installations.configurations??installations.installations??[]).map(x=>({id:x.id,slug:x.slug??x.integration?.slug,projectIds:x.projects,resources:(x.resources??[]).map(r=>({id:r.id,name:r.name}))}))
 const cfg=report.neonVariables[0]?.configurationId;if(cfg){const stores=await ver('/v1/storage/stores?projectId='+TARGET.publicApp+'&teamId='+TARGET.team);report.storeMetadataKeys=Object.keys(stores);report.neonResources=(stores.stores??stores.items??[]).map(r=>({id:r.id,name:r.name,type:r.type,projectIds:r.projects?.map(p=>p.projectId??p.id)}))}
}
export function runtimeLogSummary(text) {
 const codes=['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_REQUIRE_ESM','ReferenceError','TypeError','SyntaxError','28P01','42P01','ENOTFOUND','ECONNREFUSED','ENOENT'];const missing=[...text.matchAll(/Cannot find (?:package|module) ['"]([^'"\n]+)['"]/g)].map(x=>x[1]).filter(x=>/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(x));return {codes:codes.filter(c=>text.includes(c)),missingPackages:[...new Set(missing)],requireUnavailable:text.includes('require is not defined'),dataKeyInvalid:text.includes('MIKKA_CLOUD_DATA_KEY must be'),cloudEditionRequired:text.includes('CLOUD_EDITION_REQUIRED'),missingAuthData:text.includes('disposable-email-domains.txt'),lineCount:text.split('\n').filter(Boolean).length}
}
async function runtimeDiagnostics(env, id, report) {
 demand(/^dpl_[A-Za-z0-9]+$/.test(id),'RUNTIME_LOG_DEPLOYMENT_SCOPE')
 try {const {stdout}=await promisify(execFile)('npx',['--yes','vercel@65.4.0','logs','--project',TARGET.app,'--deployment',id,'--json','--since','30m','--limit','30','--scope',TARGET.team,'--token',env.VERCEL_TEAM_TOKEN],{env:{...env,VERCEL_TELEMETRY_DISABLED:'1'},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:8*1024*1024});report.runtimeLogs=runtimeLogSummary(stdout);report.runtimeLogs.status='read';report.runtimeLogs.jsonTypes=stdout.split('\n').filter(Boolean).map(line=>{try{const row=JSON.parse(line);return ['summary','log','runtime_log','runtime-log','error'].includes(row.type)?row.type:'OTHER'}catch{return 'OTHER'}})}catch{report.runtimeLogs={status:'unavailable'}}
 let text='';const signal=AbortSignal.timeout(18000)
 const logs=async()=>{try{const r=await fetch('https://api.vercel.com/v1/projects/'+TARGET.app+'/deployments/'+id+'/runtime-logs?teamId='+TARGET.team,{headers:{authorization:'Bearer '+env.VERCEL_TEAM_TOKEN},redirect:'error',signal});report.runtimeStreamStatus=r.status;if(!r.ok){await r.body?.cancel();return}const reader=r.body.getReader();const decoder=new TextDecoder();try{while(text.length<256*1024){const p=await reader.read();if(p.done)break;text+=decoder.decode(p.value,{stream:true})}}finally{await reader.cancel().catch(()=>{})}}catch{report.runtimeStreamEndedByDeadline=signal.aborted}}
 const trigger=async()=>{try{const r=await fetch('https://mikka-cloud.vercel.app/mikka/cloud/health',{redirect:'error',signal:AbortSignal.timeout(10000)});report.runtimeProbeStatus=r.status;await r.body?.cancel()}catch{report.runtimeProbeStatus=null}}
 await Promise.allSettled([logs(),trigger()]);report.runtimeStream=runtimeLogSummary(text)
}

export async function readiness({env=process.env,fetcher=fetch,report}) {
 const email=env.SMOKE_OWNER_EMAIL,password=env.SMOKE_OWNER_PASSWORD
 demand(typeof email==='string' && /^[^@\s]+\+mikka-smoke(?:-[a-z0-9]+)*@[^@\s]+$/i.test(email) && password,'SHARED_SMOKE_ACCOUNT_REQUIRED')
 const publicOrigin='https://app.aspectlylabs.com', privateOrigin='https://mikka-cloud.vercel.app';let cookie=''
 if(env.VERCEL_TEAM_TOKEN){
  const ver=async path=>{const r=await fetcher('https://api.vercel.com'+path,{headers:{authorization:'Bearer '+env.VERCEL_TEAM_TOKEN},redirect:'error',signal:AbortSignal.timeout(20000)});report.requests.push({operation:'private_deployment_metadata',status:r.status});demand(r.ok,'READINESS_VERCEL_METADATA');return r.json()}
  const p=await ver('/v9/projects/'+TARGET.app+'?teamId='+TARGET.team);demand(p.id===TARGET.app&&p.accountId===TARGET.team,'READINESS_VERCEL_TARGET');const d=p.targets?.production;report.privateDeployment={id:d?.id??null,source:d?.meta?.githubCommitSha??null,state:d?.readyState??null,url:d?.url??null,ssoDeploymentType:p.ssoProtection?.deploymentType??null,passwordProtectionEnabled:!!p.passwordProtection};
  const a=await ver('/v4/aliases/mikka-cloud.vercel.app?teamId='+TARGET.team);report.privateAlias={projectMatches:(a.projectId??a.project?.id)===TARGET.app,deploymentId:a.deploymentId??a.deployment?.id??null}

 }

 const request=async(operation,origin,path,body)=>{demand([publicOrigin,privateOrigin].includes(origin) && path.startsWith('/mikka/'),'READINESS_REQUEST_SCOPE');let r
 try {r=await fetcher(origin+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{origin:publicOrigin,'cache-control':'no-store',...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})}catch{throw Error('READINESS_TRANSPORT')}
 report.http.push({operation,status:r.status});return r}
 try {
 const login=await request('shared_account_login',publicOrigin,'/mikka/api/auth/sign-in/email',{email,password});demand(login.ok,'READINESS_LOGIN_HTTP');cookie=login.headers.getSetCookie().map(x=>x.split(';',1)[0]).join('; ');demand(cookie,'READINESS_SESSION_COOKIE');await login.body?.cancel()
 const sr=await request('shared_account_identity',publicOrigin,'/mikka/api/auth/get-session');demand(sr.ok,'READINESS_SESSION_HTTP');const session=await sr.json();demand(session.user?.email?.toLowerCase()===email.toLowerCase(),'READINESS_ACCOUNT_MISMATCH');report.sharedAccountVerified=true
 const vr=await request('public_version',publicOrigin,'/mikka/api/version');demand(vr.ok,'READINESS_VERSION_HTTP');const version=await vr.json();demand(/^[a-f0-9]{40}$/.test(version.build??''),'READINESS_VERSION_SCHEMA');report.publicVersion=version.build
 const gr=await request('shared_account_github',publicOrigin,'/mikka/api/integrations/github');const gh=gr.ok?await gr.json():null;report.github={status:gr.status,configured:gh?.configured===true,connected:gh?.connected===true,installed:gh?.installed===true,repositoryCount:Array.isArray(gh?.repositories)?gh.repositories.length:0}
 const br=await request('shared_account_bots',publicOrigin,'/mikka/api/bots');const bots=br.ok?await br.json():[];const bot=Array.isArray(bots)?bots.find(x=>x.name==='Smoke Bot'):null
 if(bot && /^[a-f0-9-]{36}$/.test(bot.id)){const mr=await request('shared_subscription_options',publicOrigin,'/mikka/api/mobile/model?bot='+bot.id);const menu=mr.ok?await mr.json():null;report.subscriptionOptions=(menu?.groups??[]).filter(g=>g.kind==='subscription').flatMap(g=>g.options??[]).map(x=>({modelId:typeof x.modelId==='string'&&/^[a-zA-Z0-9/_.:-]{1,100}$/.test(x.modelId)?x.modelId:'OTHER',available:x.available===true}))}
 const hr=await request('private_health',privateOrigin,'/mikka/cloud/health');report.privateHealth={status:hr.status,vercelError:['DEPLOYMENT_NOT_FOUND','FUNCTION_INVOCATION_FAILED','FUNCTION_NOT_FOUND','AUTHENTICATION_REQUIRED'].includes(hr.headers.get('x-vercel-error'))?hr.headers.get('x-vercel-error'):null};if(!hr.ok && env.VERCEL_TEAM_TOKEN && report.privateDeployment?.id)await runtimeDiagnostics(env,report.privateDeployment.id,report);demand(hr.ok && (await hr.json()).ok===true,'READINESS_PRIVATE_HEALTH')
 const dr=await request('private_discovery',privateOrigin,'/mikka/cloud/.well-known/oauth-authorization-server');demand(dr.ok && (await dr.json()).issuer===publicOrigin+'/mikka/cloud','READINESS_ISSUER')
 const cr=await request('private_browser_context',privateOrigin,'/mikka/cloud/v1/management/context');demand(cr.ok,'READINESS_CONTEXT_HTTP');const context=await cr.json();demand(Array.isArray(context.workspaces) && typeof context.csrfToken==='string','READINESS_CONTEXT_SCHEMA')
 report.workspaces=context.workspaces.map(w=>({kind:['personal','team'].includes(w.kind)?w.kind:'OTHER',role:['admin','member'].includes(w.role)?w.role:'OTHER'}));report.teamAdminAvailable=context.workspaces.some(w=>w.kind==='team'&&w.role==='admin');report.enabledScopes=(context.enabledScopes??[]).filter(x=>['github','push','models'].includes(x))
 report.result='production_readiness_verified';report.businessAcceptanceComplete=false
 } finally {if(cookie){try{const logout=await request('shared_account_logout',publicOrigin,'/mikka/api/auth/sign-out',{});await logout.body?.cancel();report.ownSessionSignedOut=logout.ok}catch{report.ownSessionSignedOut=false}}}
}

async function main(){const report={phase:'prepare-private-cloud',result:'blocked',requests:[],applicationSecretValuesRequested:false,credentialsWrittenToGitHub:false,newIdentityCreated:false};try{
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));assertExecution(process.env,event,git('rev-parse','HEAD'),git('rev-parse','HEAD^'),git('diff','--name-only','HEAD^','HEAD').split('\n'))
 if(process.argv[2]==='--preflight')report.result='source_verified';else if(process.argv[2]==='--readiness'){report.phase='private_cloud_readiness';report.http=[];await readiness({report})}else if(process.argv[2]==='--business'){report.phase='cloud_protocol_acceptance';report.http=[];await businessAcceptance({report})}else {demand(process.argv[2]==='--prepare','MODE');await prepare({report})}
 }catch(e){report.error=process.argv[2]==='--business'?acceptanceCode(e):/^[A-Z0-9_]+$/.test(e.message)?e.message:'RELEASE_PREPARATION_FAILED';process.exitCode=1}console.log(JSON.stringify(report));if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'\n```json\n'+JSON.stringify(report)+'\n```\n')}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main()

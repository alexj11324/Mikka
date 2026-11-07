import { randomBytes } from 'node:crypto'
import { readFile, appendFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { login } from './infisical-cloud-capabilities.mjs'
export const TARGET = { base: '355c066c451d079dfb11c25793f2bbeb4c2e4691', repo: 'alexj11324/Mikka', ref: 'refs/heads/ops/infisical-cloud-capabilities', project:'89850d6a-f020-4936-863e-df77380dfe40', connection:'d5107d5c-fc41-4f42-a5b1-b77858811bdf', team:'team_C7lwxVVvnUicFli6112mvxpv', app:'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc', publicApp:'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', path:'/mikka-cloud-production' }
const owned=['.github/workflows/infisical-cloud-capabilities.yml','scripts/ops/self-hosting-release.mjs','scripts/ops/self-hosting-release.test.mjs']
export function assertExecution(env,event,head,parent,changed) {
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_REPOSITORY!==TARGET.repo||env.GITHUB_REPOSITORY_ID!=='1427517699'||env.GITHUB_REPOSITORY_OWNER_ID!=='183887963'||env.GITHUB_ACTOR!=='alexj11324'||env.GITHUB_EVENT_NAME!=='push'||env.GITHUB_REF!==TARGET.ref||event.repository?.full_name!==TARGET.repo||event.ref!==TARGET.ref||event.after!==head||env.GITHUB_SHA!==head||event.forced||parent!==TARGET.base||changed.length!==owned.length||changed.some(p=>!owned.includes(p))) throw Error('EXECUTION_SCOPE')
}
export function reference(path,key) { if(!/^\/[a-zA-Z0-9/_-]+$/.test(path)||!/^\w+$/.test(key))throw Error('REFERENCE_SCOPE');return '${prod.'+path.slice(1).replaceAll('/','.')+'.'+key+'}' }
export const REQUIRED={BETTER_AUTH_SECRET:'/vercel',MIKKA_DATABASE_URL:'/vercel',GITHUB_APP_ID:'/github',GITHUB_APP_PRIVATE_KEY:'/github',GITHUB_WEBHOOK_SECRET:'/github',GITHUB_CLIENT_ID:'/vercel',GITHUB_CLIENT_SECRET:'/vercel',WORKSPACE_SECRETS_KEY:'/vercel'}
const OPTIONAL=['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','BETTER_AUTH_OAUTH_PROXY_URL','BETTER_AUTH_OAUTH_PROXY_SECRET','LINEAR_TOKEN_ENCRYPTION_KEY','OPENCODE_API_KEY','ZEROCAT_API_KEY','ZEROCAT_BASE_URL','DECISION_GATEWAY_API_KEY']
const constants={MIKKA_EDITION:'cloud',MIKKA_CLOUD_URL:'https://app.aspectlylabs.com/mikka/cloud',BETTER_AUTH_URL:'https://app.aspectlylabs.com',MIKKA_BASE_PATH:'/mikka',GITHUB_APP_SLUG:'mikka-github'}
function demand(v,code){if(!v)throw Error(code)}
export function secretPlan(rows) {
 demand(Array.isArray(rows)&&rows.length<3000,'SECRET_METADATA_SCHEMA')
 const exists=(p,k)=>rows.some(r=>r.secretPath===p&&r.secretKey===k)
 const plan={...constants}
 for(const [key,path] of Object.entries(REQUIRED)){demand(exists(path,key),'SOURCE_REQUIRED_'+key);plan[key]=reference(path,key)}
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
 const available=await inf('/api/v1/app-connections/vercel/available?projectId='+TARGET.project);demand(available.appConnections?.some(c=>c.id===TARGET.connection&&c.name==='mikka-team-vercel-native-sync'),'CONNECTION_NOT_AVAILABLE')
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
  const retired=syncs.secretSyncs.filter(s=>s.name==='mikka-vercel-skill-acceptance'&&s.destinationConfig?.app===TARGET.publicApp&&s.destinationConfig?.env==='preview'&&s.destinationConfig?.branch==='codex/self-improvement-acceptance-20261026');demand(retired.length===1,'RETIRED_SYNC_NOT_EXACT')
  const prResponse=await fetcher('https://api.github.com/repos/alexj11324/Mikka/pulls/316',{headers:{accept:'application/vnd.github+json',...(env.GITHUB_TOKEN?{authorization:'Bearer '+env.GITHUB_TOKEN}:{})},redirect:'error',signal:AbortSignal.timeout(15000)});demand(prResponse.ok,'RETIRED_PR_HTTP');const pr=await prResponse.json();demand(pr.state==='closed'&&pr.head?.ref==='codex/self-improvement-acceptance-20261026','RETIRED_PR_ACTIVE')
  const body=syncBody();delete body.projectId
  const updated=await inf('/api/v1/secret-syncs/vercel/'+retired[0].id,'PATCH',body);report.syncId=updated.secretSync?.id;report.retiredPreviewSyncReused=true;report.retiredPullRequest=316;report.existingProductionSyncsUnchanged=true
 }

 else {const s=existing[0];demand(s.connection?.id===TARGET.connection&&s.folder?.path===TARGET.path&&s.environment?.slug==='prod'&&s.syncOptions?.disableSecretDeletion===true&&!s.syncOptions?.includeAllSubFolders,'SYNC_SCOPE');report.syncId=s.id}
 demand(typeof report.syncId==='string','SYNC_CREATE_SCHEMA')
 report.result='source_and_sync_prepared'
 // Provider-owned metadata only: locate the existing Neon connection on the public project.
 const publicEnv=await ver('/v10/projects/'+TARGET.publicApp+'/env?teamId='+TARGET.team+'&decrypt=false');demand(Array.isArray(publicEnv.envs),'PUBLIC_METADATA_SCHEMA')
 report.neonVariables=publicEnv.envs.filter(x=>['DATABASE_URL','DATABASE_URL_UNPOOLED'].includes(x.key)&&x.target?.includes('production')&&!x.gitBranch).map(x=>({name:x.key,configurationId:x.configurationId??null,contentHint:x.contentHint??null,system:!!x.system}))
 report.privateVariableNames=(await ver('/v10/projects/'+TARGET.app+'/env?teamId='+TARGET.team+'&decrypt=false')).envs.filter(x=>x.target?.includes('production')).map(x=>x.key)
 const installations=await ver('/v1/integrations/configurations?view=account&teamId='+TARGET.team)
 report.integrationMetadata=(installations.configurations??installations.installations??[]).map(x=>({id:x.id,slug:x.slug??x.integration?.slug,projectIds:x.projects,resources:(x.resources??[]).map(r=>({id:r.id,name:r.name}))}))
 const cfg=report.neonVariables[0]?.configurationId;if(cfg){const stores=await ver('/v1/storage/stores?projectId='+TARGET.publicApp+'&teamId='+TARGET.team);report.storeMetadataKeys=Object.keys(stores);report.neonResources=(stores.stores??stores.items??[]).map(r=>({id:r.id,name:r.name,type:r.type,projectIds:r.projects?.map(p=>p.projectId??p.id)}))}
}
async function main(){const report={phase:'prepare-private-cloud',result:'blocked',requests:[],applicationSecretValuesRequested:false,credentialsWrittenToGitHub:false,newIdentityCreated:false};try{
 const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));assertExecution(process.env,event,git('rev-parse','HEAD'),git('rev-parse','HEAD^'),git('diff','--name-only','HEAD^','HEAD').split('\n'))
 if(process.argv[2]==='--preflight')report.result='source_verified';else {demand(process.argv[2]==='--prepare','MODE');await prepare({report})}
 }catch(e){report.error=/^[A-Z0-9_]+$/.test(e.message)?e.message:'RELEASE_PREPARATION_FAILED';process.exitCode=1}console.log(JSON.stringify(report));if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'\n```json\n'+JSON.stringify(report)+'\n```\n')}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main()

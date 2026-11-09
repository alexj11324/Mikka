import { createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const e = process.env
export const auditPath = join(e.RUNNER_TEMP, 'diagnostic-prepare-guard.json')
export let audit = {version:1,issue:1505,mode:'fresh_prepare_only',status:'running',modelsDispatched:0,
  runId:e.GITHUB_RUN_ID,attempt:e.GITHUB_RUN_ATTEMPT,head:e.GITHUB_SHA,observations:[]}
export class GuardError extends Error { constructor(code){super(code);this.code=code} }
export function check(value,code){if(!value)throw new GuardError(code)}
export const safeCode = error => error instanceof GuardError ? error.code : 'prepare_internal_error'
export async function saveJson(path,value){
  const temporary=path+'.tmp'
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600})
  await rename(temporary,path)
}
export async function saveAudit(){await saveJson(auditPath,audit)}
export async function loadAudit(){audit=JSON.parse(await readFile(auditPath,'utf8'))}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (cwd,...args) => execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
const originalSha='12f6f3758c382dd55c9055b3ab32f9d785c620594c66ad4d49a2030b3ccda8d5'
export const branch='ops/1505-smoke-github-readonly-20261109'
export const go='root-reviewed-1505-diagnostic-prepare-r7-v1'
export const paths=[
 '.github/workflows/issue1505-diagnostic-window.yml',
 'scripts/ops/issue1505-diagnostic-window.mjs',
 'scripts/ops/issue1505-diagnostic-window-original-42366750743.json'
]
export const sourceDir=resolve(e.GITHUB_WORKSPACE,'source')
export const opsDir=resolve(e.GITHUB_WORKSPACE,'ops')
export const helperPath=join(opsDir,paths[1])
export const originalPath=join(opsDir,paths[2])
export function pinValidation(){
  for(const key of ['EXPECTED_APP_SOURCE','EXPECTED_APP_TREE','HELPER_PARENT','HELPER_PARENT_TREE','UPSTREAM_RUNTIME_SOURCE'])
    check(/^[0-9a-f]{40}$/.test(e[key]??''),'source_pin_unfilled')
  check(/^[0-9a-f]{64}$/.test(e.HELPER_SHA256??''),'helper_hash_unfilled')
  check(e.DIAGNOSTIC_WINDOW_GO===go,'go_unfilled')
  check(e.HELPER_PARENT===e.EXPECTED_APP_SOURCE&&e.HELPER_PARENT_TREE===e.EXPECTED_APP_TREE,'parent_pin_mismatch')
  check(/^[0-9a-f]{40}$/.test(e.CLOSED_CARRIER_PARENT??'')&&e.CLOSED_CARRIER_PARENT!==e.HELPER_PARENT,'carrier_parent_invalid')
  for(const key of ['UPSTREAM_RUN_ID','UPSTREAM_ATTEMPT'])
    check(/^[1-9][0-9]*$/.test(e[key]??'')&&Number.isSafeInteger(Number(e[key])),'runtime_pin_unfilled')
  for(const key of ['NOT_BEFORE','ENTRY_DEADLINE','HARD_DEADLINE'])
    check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(e[key]??'')&&Number.isFinite(Date.parse(e[key])),'window_unfilled')
  const start=Date.parse(e.NOT_BEFORE),entry=Date.parse(e.ENTRY_DEADLINE),hard=Date.parse(e.HARD_DEADLINE)
  check(start<entry&&entry+600_000<=hard&&hard-start<=900_000,'window_budget_invalid')
  check(e.GITHUB_REPOSITORY==='alexj11324/Mikka'&&e.GITHUB_REF==='refs/heads/'+branch
    &&e.GITHUB_RUN_ATTEMPT==='1'&&/^[0-9a-f]{40}$/.test(e.GITHUB_SHA??''),'workflow_identity_invalid')
}
export function windowGuard(entry=false){
  const now=Date.now(),start=Date.parse(e.NOT_BEFORE),limit=Date.parse(entry?e.ENTRY_DEADLINE:e.HARD_DEADLINE)
  check(Number.isFinite(start)&&Number.isFinite(limit)&&now>=start&&now<limit,entry?'entry_window_closed':'hard_window_closed')
}
export async function boundedFetch(input,init={}){
  windowGuard()
  const remaining=Math.max(1,Date.parse(e.HARD_DEADLINE)-Date.now())
  const timer=AbortSignal.timeout(Math.min(30_000,remaining))
  const signal=init.signal?AbortSignal.any([init.signal,timer]):timer
  const response=await fetch(input,{...init,signal})
  windowGuard()
  return response
}
export async function metadata(path){
  windowGuard()
  check(typeof e.GITHUB_TOKEN==='string'&&e.GITHUB_TOKEN.length>0,'github_token_missing')
  let response,data
  try{
    response=await boundedFetch('https://api.github.com/repos/alexj11324/Mikka/'+path,{
      redirect:'error',headers:{authorization:'Bearer '+e.GITHUB_TOKEN,accept:'application/vnd.github+json',
      'x-github-api-version':'2022-11-28'}})
    check(response.status===200,'metadata_http_failed')
    data=await response.json()
    windowGuard()
    return data
  }catch(error){if(error instanceof GuardError)throw error;throw new GuardError('metadata_request_failed')}
}
export async function currentMain(stage,entry=false){
  windowGuard(entry)
  const result=await metadata('git/ref/heads/main')
  windowGuard(entry)
  check(result?.ref==='refs/heads/main'&&result.object?.type==='commit'&&result.object.sha===e.EXPECTED_APP_SOURCE,
    'current_main_changed')
  audit.observations.push({stage,main:e.EXPECTED_APP_SOURCE,at:new Date().toISOString()})
  await saveAudit()
}
export async function localGuard(){
  pinValidation();windowGuard(true)
  check(git(sourceDir,'rev-parse','HEAD')===e.EXPECTED_APP_SOURCE,'source_head_mismatch')
  check(git(sourceDir,'rev-parse','HEAD^{tree}')===e.EXPECTED_APP_TREE,'source_tree_mismatch')
  check(git(opsDir,'rev-parse','HEAD')===e.GITHUB_SHA,'helper_head_mismatch')
  const parents=git(opsDir,'rev-list','--parents','-n','1','HEAD').split(' ').slice(1)
  check(parents.length===2&&parents[0]===e.HELPER_PARENT&&parents[1]===e.CLOSED_CARRIER_PARENT,'helper_parent_mismatch')
  check(git(opsDir,'rev-parse',e.HELPER_PARENT+'^{tree}')===e.HELPER_PARENT_TREE,'helper_parent_tree_mismatch')
  const raw=git(opsDir,'diff','--raw','--no-renames','--abbrev=40',e.HELPER_PARENT,'HEAD').split('\n')
  check(raw.length===paths.length,'helper_scope_mismatch')
  const seen=new Set()
  for(const line of raw){
    const pair=line.split('\t'),fields=pair[0].split(' ')
    check(pair.length===2&&paths.includes(pair[1])&&!seen.has(pair[1])&&fields.length===5
      &&fields[0]===':000000'&&fields[1]==='100644'&&fields[4]==='A','helper_scope_mismatch')
    seen.add(pair[1])
  }
  for(const directory of [sourceDir,opsDir]){
    check(git(directory,'diff','--name-only','HEAD')==='','tracked_worktree_changed')
    check(git(directory,'diff','--cached','--name-only')==='','tracked_index_changed')
  }
  check(sha(await readFile(helperPath))===e.HELPER_SHA256,'helper_bytes_changed')
  check(sha(await readFile(originalPath))===originalSha,'original_receipt_changed')
  const h=await import(pathToFileURL(helperPath).href)
  check(h.SOURCE===e.EXPECTED_APP_SOURCE&&h.TREE===e.EXPECTED_APP_TREE&&h.BRANCH===branch
    &&h.HELPER_PARENT===e.HELPER_PARENT&&h.HELPER_PARENT_TREE===e.HELPER_PARENT_TREE&&h.GO===go,'helper_constants_mismatch')
  check(typeof h.prepareWindow==='function'&&typeof h.readOriginalBot==='function','helper_exports_invalid')
  const driver=await import(pathToFileURL(join(sourceDir,'scripts/acceptance/cloud-startup.mjs')).href)
  for(const name of ['createSessionClient','smokeAcceptanceAccount','selectAcceptanceTeam','restoreAcceptanceWorkspace'])
    check(typeof driver[name]==='function','driver_import_invalid')
  audit.sourceCommit=e.EXPECTED_APP_SOURCE;audit.sourceTree=e.EXPECTED_APP_TREE;audit.helperSha256=e.HELPER_SHA256
  audit.originalReceiptSha256=originalSha
  audit.window={notBefore:e.NOT_BEFORE,entryDeadline:e.ENTRY_DEADLINE,hardDeadline:e.HARD_DEADLINE}
  await saveAudit()
  return {helper:h,driver}
}
const jobs=['test','check','validate / build','await-web','subscriptions','publish / deploy','cleanup']
function checkRun(run){
  check(run?.id===Number(e.UPSTREAM_RUN_ID)&&run.run_attempt===Number(e.UPSTREAM_ATTEMPT)
    &&run.head_sha===e.UPSTREAM_RUNTIME_SOURCE&&run.head_branch==='main'&&run.event==='push'
    &&run.path==='.github/workflows/e2b-official-runtime.yml'&&run.repository?.full_name==='alexj11324/Mikka'
    &&run.status==='completed'&&run.conclusion==='success','runtime_run_not_exact_success')
}
export async function upstreamOnce(){
  const path='actions/runs/'+e.UPSTREAM_RUN_ID
  checkRun(await metadata(path))
  const result=await metadata(path+'/attempts/'+e.UPSTREAM_ATTEMPT+'/jobs?per_page=100')
  check(result?.total_count===7&&Array.isArray(result.jobs)&&result.jobs.length===7,'runtime_jobs_incomplete')
  const names=new Set(),ids=new Set()
  for(const job of result.jobs){
    check(jobs.includes(job.name)&&!names.has(job.name)&&Number.isSafeInteger(job.id)&&job.id>0&&!ids.has(job.id)
      &&job.run_id===Number(e.UPSTREAM_RUN_ID)&&job.run_attempt===Number(e.UPSTREAM_ATTEMPT)
      &&job.head_sha===e.UPSTREAM_RUNTIME_SOURCE&&job.head_branch==='main'
      &&job.status==='completed'&&job.conclusion==='success','runtime_job_not_exact_success')
    names.add(job.name);ids.add(job.id)
  }
  checkRun(await metadata(path))
  windowGuard(true)
  audit.upstream={source:e.UPSTREAM_RUNTIME_SOURCE,runId:e.UPSTREAM_RUN_ID,attempt:e.UPSTREAM_ATTEMPT,
    jobs:result.jobs.map(({id,name,status,conclusion})=>({id,name,status,conclusion})),verifiedAt:new Date().toISOString()}
  await saveAudit()
}
export async function preflight(){
  try{
    await localGuard()
    await currentMain('before_oidc',true)
    await upstreamOnce()
    audit.status='preflight_passed';await saveAudit()
  }catch(error){
    audit.status='failed';audit.code=safeCode(error);await saveAudit();process.exitCode=1
  }
}

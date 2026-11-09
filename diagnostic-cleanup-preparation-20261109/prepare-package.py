from pathlib import Path
import subprocess, hashlib, json, textwrap, re, ast, datetime
import yaml
ROOT=Path('/workspace/scratch/263e36984c81/diagnostic-cleanup-preparation-1505')
REPO=Path('/workspace/scratch/263e36984c81/Mikka-1505')
HELPER_COMMIT='5958dea38437de20512bbbdf60b940ccc83f00ff'
TEMPLATE_COMMIT='29218a0ff3f8dd458963eed3956666572b564309'
SOURCE_PATH='scripts/ops/issue1505-diagnostic-window.mjs'
HELPER_PATH='scripts/ops/issue1505-diagnostic-cleanup-r7.mjs'
WF_PATH='.github/workflows/issue1505-diagnostic-cleanup-r7.yml'
TEMPLATE_PATH='evidence/1505-startup-timing-20261108/formal-renderer/workflow.template.yml.in'
def git(*args): return subprocess.check_output(['git',*args],cwd=REPO)
def sha(data): return hashlib.sha256(data).hexdigest()
def blob(data): return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def put(path,data):
 p=ROOT/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data.encode() if isinstance(data,str) else data)
def dump(path,data): put(path,json.dumps(data,ensure_ascii=False,indent=2)+'\n')
helper=git('show',f'{HELPER_COMMIT}:{SOURCE_PATH}')
assert sha(helper)=='46d8b905518cf480fecdf0a3bce1a3863f4e79c92609b1cd3ec9d4231820898c'
assert blob(helper)=='e9f07af8ec87eb83b3eb46c046731390ba97c1d9'
put(HELPER_PATH,helper)
original=git('show',f'{TEMPLATE_COMMIT}:{TEMPLATE_PATH}').decode()
start=original.index('          const env=process.env;',original.index('- name: Remove only the exact prepared project diagnostic window'))
end=original.index('          let report;',start)
pure=textwrap.dedent(original[start:end])
put('provenance/original-pure-call.txt',pure)
bindings={'version':1,'baseCommit':None,'baseTree':None,'currentMainCommit':None,'currentMainTree':None,'freshScopeReceiptSha256':None,'diagnosticEnvId':None,'diagnosticValueSha256':None,'diagnosticExpiresAt':None,'startAt':None,'latestEntryAt':None,'hardEndAt':None,'rootReviewGo':None}
dump('bindings.unfilled.json',bindings)
common=r'''import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const EXPECTED_BRANCH='ops/1505-diagnostic-cleanup-r7-20261109';
const EXPECTED_GO='root-reviewed-1505-diagnostic-cleanup-r7-20261109-v1';
const HELPER_PATH='scripts/ops/issue1505-diagnostic-cleanup-r7.mjs';
const WORKFLOW_PATH='.github/workflows/issue1505-diagnostic-cleanup-r7.yml';
const HELPER_SHA='46d8b905518cf480fecdf0a3bce1a3863f4e79c92609b1cd3ec9d4231820898c';
const HELPER_BLOB='e9f07af8ec87eb83b3eb46c046731390ba97c1d9';
const CLOSED=new Set(['bindings_invalid','execution_identity_invalid','source_identity_invalid','source_delta_invalid','helper_bytes_invalid','time_window_invalid','main_metadata_failed','main_changed','preflight_receipt_invalid','cleanup_guard_internal_error']);
const must=(value,code)=>{if(!value)throw Object.assign(new Error(code),{cleanupGuardCode:code});};
const failCode=error=>CLOSED.has(error?.cleanupGuardCode)?error.cleanupGuardCode:'cleanup_guard_internal_error';
let pins;
let cleanupInvocationStarted=false,deleteAttempted=false,deleteOutcome='not_attempted';
const rawFetch=globalThis.fetch;
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function bind(){
 try { pins=JSON.parse(process.env.CLEANUP_BINDINGS_JSON??'null'); } catch { must(false,'bindings_invalid'); }
 must(pins?.version===1,'bindings_invalid');
 for(const key of ['baseCommit','baseTree','currentMainCommit','currentMainTree'])must(typeof pins[key]==='string'&&/^[a-f0-9]{40}$/.test(pins[key]),'bindings_invalid');
 must(pins.baseCommit===pins.currentMainCommit&&pins.baseTree===pins.currentMainTree,'bindings_invalid');
 for(const key of ['freshScopeReceiptSha256','diagnosticValueSha256'])must(typeof pins[key]==='string'&&/^[a-f0-9]{64}$/.test(pins[key]),'bindings_invalid');
 must(typeof pins.diagnosticEnvId==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(pins.diagnosticEnvId)&&!pins.diagnosticEnvId.startsWith('READY_'),'bindings_invalid');
 for(const key of ['diagnosticExpiresAt','startAt','latestEntryAt','hardEndAt'])must(typeof pins[key]==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(pins[key])&&Number.isFinite(Date.parse(pins[key])),'bindings_invalid');
 must(pins.rootReviewGo===EXPECTED_GO,'bindings_invalid');
 const e=process.env;
 must(e.GITHUB_REPOSITORY==='alexj11324/Mikka'&&e.GITHUB_EVENT_NAME==='push'&&e.GITHUB_REF===`refs/heads/${EXPECTED_BRANCH}`&&e.GITHUB_RUN_ATTEMPT==='1'&&/^[a-f0-9]{40}$/.test(e.GITHUB_SHA??''),'execution_identity_invalid');
 must(e.GITHUB_WORKFLOW_REF===`alexj11324/Mikka/${WORKFLOW_PATH}@refs/heads/${EXPECTED_BRANCH}`,'execution_identity_invalid');
 must(typeof e.GITHUB_TOKEN==='string'&&e.GITHUB_TOKEN.length>0,'execution_identity_invalid');
 must(git('rev-parse','HEAD')===e.GITHUB_SHA&&git('show','-s','--format=%P','HEAD')===pins.currentMainCommit,'source_identity_invalid');
 must(git('rev-parse',`${pins.currentMainCommit}^{tree}`)===pins.currentMainTree,'source_identity_invalid');
 const expected=[`A\t${WORKFLOW_PATH}`,`A\t${HELPER_PATH}`].sort();
 const actual=git('diff-tree','--no-commit-id','--name-status','--no-renames','-r',pins.currentMainCommit,'HEAD').split('\n').sort();
 must(JSON.stringify(actual)===JSON.stringify(expected),'source_delta_invalid');
 for(const path of [WORKFLOW_PATH,HELPER_PATH])must(git('ls-tree','HEAD','--',path).startsWith('100644 blob '),'source_delta_invalid');
 must(git('status','--porcelain=v1','--untracked-files=no')==='','source_identity_invalid');
 must(git('rev-parse',`HEAD:${HELPER_PATH}`)===HELPER_BLOB&&createHash('sha256').update(readFileSync(HELPER_PATH)).digest('hex')===HELPER_SHA,'helper_bytes_invalid');
}
function clockGuard(entry){
 const now=Date.now(),start=Date.parse(pins.startAt),last=Date.parse(pins.latestEntryAt),end=Date.parse(pins.hardEndAt);
 must(start<=last&&last+600_000<=end&&now>=start&&now<end,'time_window_invalid');
 if(entry)must(now<=last&&now+600_000<=end,'time_window_invalid');
 else {const receipt=JSON.parse(readFileSync('acceptance-results/cleanup-preflight.json','utf8'));must(receipt.status==='passed'&&receipt.operatorCommit===process.env.GITHUB_SHA&&receipt.freshScopeReceiptSha256===pins.freshScopeReceiptSha256&&Number.isFinite(Date.parse(receipt.actualEntryAt)),'preflight_receipt_invalid');must(now>=Date.parse(receipt.actualEntryAt)&&now-Date.parse(receipt.actualEntryAt)<600_000,'time_window_invalid');}
}
async function currentMain(){
 let response,data;
 try {response=await rawFetch('https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main',{redirect:'error',signal:AbortSignal.timeout(10_000),headers:{accept:'application/vnd.github+json',authorization:`Bearer ${process.env.GITHUB_TOKEN}`,'x-github-api-version':'2022-11-28'}});must(response.ok,'main_metadata_failed');data=await response.json();} catch(error){must(false,'main_metadata_failed');}
 must(data?.ref==='refs/heads/main'&&data?.object?.type==='commit'&&data.object.sha===pins.currentMainCommit,'main_changed');
}
function saveClosed(code){const report={version:1,issue:1505,status:'failed',code,cleanupAttempted:cleanupInvocationStarted,deleteAttempted,deleteOutcome,projectEnvironmentRemoved:deleteAttempted?null:false,activeDeploymentRevoked:false};try{mkdirSync('acceptance-results',{recursive:true});writeFileSync('acceptance-results/diagnostic-window-cleanup.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});}catch{console.log(JSON.stringify({status:'failed',code:'cleanup_report_write_failed'}));}console.log(JSON.stringify(report));process.exitCode=1;}
'''
entry=common+r'''try {
 bind();clockGuard(true);await currentMain();clockGuard(true);
 mkdirSync('acceptance-results',{recursive:true});
 writeFileSync('acceptance-results/cleanup-preflight.json',JSON.stringify({version:1,status:'passed',operatorCommit:process.env.GITHUB_SHA,operatorTree:git('rev-parse','HEAD^{tree}'),parent:pins.currentMainCommit,parentTree:pins.currentMainTree,helperSha256:HELPER_SHA,freshScopeReceiptSha256:pins.freshScopeReceiptSha256,actualEntryAt:new Date().toISOString(),hardEndAt:pins.hardEndAt},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'passed',stage:'before_oidc'}));
} catch(error) {saveClosed(failCode(error));}
'''
cleanup=common+r'''import { mkdir, writeFile } from 'node:fs/promises';
import { removeOwnedWindow, SOURCE, TREE, PROJECT, TEAM, KEY } from './scripts/ops/issue1505-diagnostic-cleanup-r7.mjs';
let deleteGuardCode=null;
try {
 bind();clockGuard(false);await currentMain();clockGuard(false);
 const guardedPlatformFetch=async(url,options)=>{
   must(new URL(url).origin==='https://api.vercel.com','execution_identity_invalid');
   if(options?.method==='DELETE'){
     try {await currentMain();clockGuard(false);} catch(error){deleteGuardCode=failCode(error);throw error;}
     deleteAttempted=true;deleteOutcome='unknown';
     writeFileSync('acceptance-results/diagnostic-window-cleanup.json',JSON.stringify({version:1,issue:1505,status:'in_progress',code:'exact_delete_requested',cleanupAttempted:true,deleteAttempted:true,deleteOutcome:'unknown',activeDeploymentRevoked:false},null,2)+'\n',{mode:0o600});
   }
   clockGuard(false);
   const remaining=Date.parse(pins.hardEndAt)-Date.now();
   must(remaining>0,'time_window_invalid');
   const deadline=AbortSignal.timeout(Math.max(1,Math.min(30_000,remaining)));
   const response=await rawFetch(url,{...options,signal:options?.signal?AbortSignal.any([options.signal,deadline]):deadline});
   if(options?.method==='DELETE')deleteOutcome=response.ok?'response_success':'response_error';
   return response;
 };
 cleanupInvocationStarted=true;
 writeFileSync('acceptance-results/diagnostic-window-cleanup.json',JSON.stringify({version:1,issue:1505,status:'in_progress',code:'cleanup_started',cleanupAttempted:true,deleteAttempted:false,deleteOutcome:'not_attempted',activeDeploymentRevoked:false},null,2)+'\n',{mode:0o600});
 process.env.EXPECTED_DIAGNOSTIC_ENV_ID=pins.diagnosticEnvId;
 process.env.EXPECTED_DIAGNOSTIC_VALUE_SHA256=pins.diagnosticValueSha256;
 process.env.EXPECTED_DIAGNOSTIC_EXPIRES_AT=pins.diagnosticExpiresAt;
'''+textwrap.indent(pure.replace("removeOwnedWindow(expected,{token:env.VERCEL_TEAM_TOKEN})","removeOwnedWindow(expected,{token:env.VERCEL_TEAM_TOKEN,fetchImpl:guardedPlatformFetch})"),' ')+r'''
 cleanup.cleanupAttempted=true;cleanup.deleteAttempted=deleteAttempted;cleanup.deleteOutcome=deleteOutcome;
 if(deleteGuardCode)cleanup.deleteGuardCode=deleteGuardCode;
 await writeFile('acceptance-results/diagnostic-window-cleanup.json',JSON.stringify(cleanup,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(cleanup));
} catch(error){saveClosed(failCode(error));}
'''
finalize=r'''import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
mkdirSync('acceptance-results',{recursive:true});
const path='acceptance-results/diagnostic-window-cleanup.json';
if(!existsSync(path))writeFileSync(path,JSON.stringify({version:1,issue:1505,status:'not_attempted',code:'cleanup_prerequisite_failed',cleanupAttempted:false,projectEnvironmentRemoved:false,activeDeploymentRevoked:false},null,2)+'\n',{mode:0o600});
'''
workflow='''# OFFLINE ONLY. All fresh bindings are null; job disabled; no active .yml is supplied.
name: Issue 1505 exact diagnostic cleanup only
on:
  push:
    branches: [ops/1505-diagnostic-cleanup-r7-20261109]
permissions:
  contents: read
concurrency:
  group: production-smoke-owner-acceptance
  cancel-in-progress: false
  queue: max
jobs:
  cleanup:
    if: false # ROOT_REVIEW_REQUIRED_UNFILLED
    runs-on: ubuntu-latest
    timeout-minutes: 10
    concurrency:
      group: web-deploy-production
      cancel-in-progress: false
      queue: max
    permissions:
      contents: read
      id-token: write
    env:
      CLEANUP_BINDINGS_JSON: |
'''+textwrap.indent(json.dumps(bindings,indent=2),'        ')+'''
    steps:
      - name: Check out this exact inert operator child
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: ${{ github.sha }}
          fetch-depth: 2
          persist-credentials: false
      - name: Use the existing Node runtime
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 24
      - name: Verify source, exact helper, parent, scope pins and entry window before OIDC
        id: source_ready
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          node --input-type=module <<'JS'
'''+textwrap.indent(entry,'          ')+'''          JS
      - name: Read only the platform token for the exact owned-window cleanup
        id: platform_token
        uses: Infisical/secrets-action@d2e351f16c6ca20d17c85e6c992e04bdeb64e87d
        with:
          method: oidc
          identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac
          oidc-audience: mikka-infisical
          project-id: 89850d6a-f020-4936-863e-df77380dfe40
          env-slug: prod
          secret-path: /platform
          secret-name: VERCEL_TEAM_TOKEN
          include-imports: false
      - name: Recheck main and time, then remove only the exact owned window
        id: cleanup_exact
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          node --input-type=module <<'JS'
'''+textwrap.indent(cleanup,'          ')+'''          JS
      - name: Preserve actual cleanup report or a closed not-attempted result
        if: always()
        run: |
          node --input-type=module <<'JS'
'''+textwrap.indent(finalize,'          ')+'''          JS
      - name: Retain only the safe cleanup and source-guard reports
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
        with:
          name: issue1505-exact-diagnostic-cleanup-${{ github.run_id }}-${{ github.run_attempt }}
          path: |
            acceptance-results/diagnostic-window-cleanup.json
            acceptance-results/cleanup-preflight.json
          if-no-files-found: error
          retention-days: 7
'''
put(WF_PATH+'.in',workflow)
checks=[]
for name,code in [('preflight',entry),('cleanup',cleanup),('retain-report',finalize)]:
 path=f'syntax/{name}.mjs';put(path,code)
 proc=subprocess.run(['node','--check',str(ROOT/path)],capture_output=True,text=True)
 checks.append({'command':['node','--check',path],'exitCode':proc.returncode,'stdout':proc.stdout,'stderr':proc.stderr});assert proc.returncode==0
proc=subprocess.run(['node','--check',str(ROOT/HELPER_PATH)],capture_output=True,text=True)
checks.append({'command':['node','--check',HELPER_PATH],'exitCode':proc.returncode,'stdout':proc.stdout,'stderr':proc.stderr});assert proc.returncode==0
parsed=yaml.safe_load(workflow)
assert parsed['jobs']['cleanup']['if'] is False
assert parsed['jobs']['cleanup']['timeout-minutes']==10
assert json.loads(parsed['jobs']['cleanup']['env']['CLEANUP_BINDINGS_JSON'])==bindings
assert all(v is None for k,v in bindings.items() if k!='version')
assert not list(ROOT.rglob('*.yml'))
assert (ROOT/HELPER_PATH).read_bytes()==helper
assert [s.get('with',{}).get('secret-name') for s in parsed['jobs']['cleanup']['steps'] if 'Infisical/' in s.get('uses','')]==['VERCEL_TEAM_TOKEN']
ast.parse((ROOT/'prepare-package.py').read_text())
dump('static-checks.json',{'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'syntax and static structure only; no workflow, helper function, network request or test executed','nodeSyntax':checks,'pythonAst':'passed','yamlParse':'passed','disabled':True,'allFreshBindingsNull':True,'activeYamlFiles':0,'exactHelperBytes':True,'singlePlatformSecret':True,'originalCheckoutStatus':git('status','--porcelain=v1').decode()})
dump('source-provenance.json',{'helper':{'commit':HELPER_COMMIT,'path':SOURCE_PATH,'newPath':HELPER_PATH,'bytes':len(helper),'sha256':sha(helper),'blob':blob(helper),'preservedBytes':True},'pureCall':{'commit':TEMPLATE_COMMIT,'path':TEMPLATE_PATH,'sourceLines':'807-821','extractedBodySha256':sha(pure.encode()),'adaptations':['import path changed to the exact helper copy','fetchImpl injected solely for main/time verification immediately before DELETE and bounded HTTPS fetch; deletion/value checks unchanged','no formal report update or sample generation']},'prospectiveOperator':{'parent':None,'tree':None,'branch':'ops/1505-diagnostic-cleanup-r7-20261109','go':'root-reviewed-1505-diagnostic-cleanup-r7-20261109-v1','exactAddedPaths':[WF_PATH,HELPER_PATH],'commitCreated':False,'refCreated':False,'activated':False},'oldSchemaConstants':{'SOURCE':'e33e3a91d4011efbe768b11b428a5d152ede744a','TREE':'b2e36d3351654fceec59fe138a55de31cb155df9','meaning':'removeOwnedWindow input-schema binding only, not a fresh scope creation receipt'},'reviewedLocalRoot':{'commit':git('rev-parse','HEAD').decode().strip(),'tree':git('rev-parse','HEAD^{tree}').decode().strip()}})
print(json.dumps({'directory':str(ROOT),'helperBytes':len(helper),'workflowBytes':len(workflow.encode()),'workflowSha256':sha(workflow.encode()),'syntaxCount':len(checks),'disabled':True}))

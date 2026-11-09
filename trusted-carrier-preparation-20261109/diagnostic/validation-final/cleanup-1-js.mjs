import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const EXPECTED_BRANCH='ops/1505-smoke-github-readonly-20261109';
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
 must(/^[a-f0-9]{40}$/.test(e.CLOSED_CARRIER_PARENT??'')&&e.CLOSED_CARRIER_PARENT!==pins.currentMainCommit,'bindings_invalid');
 must(e.GITHUB_REPOSITORY==='alexj11324/Mikka'&&e.GITHUB_EVENT_NAME==='push'&&e.GITHUB_REF===`refs/heads/${EXPECTED_BRANCH}`&&e.GITHUB_RUN_ATTEMPT==='1'&&/^[a-f0-9]{40}$/.test(e.GITHUB_SHA??''),'execution_identity_invalid');
 must(e.GITHUB_WORKFLOW_REF===`alexj11324/Mikka/${WORKFLOW_PATH}@refs/heads/${EXPECTED_BRANCH}`,'execution_identity_invalid');
 must(typeof e.GITHUB_TOKEN==='string'&&e.GITHUB_TOKEN.length>0,'execution_identity_invalid');
 must(git('rev-parse','HEAD')===e.GITHUB_SHA&&git('show','-s','--format=%P','HEAD')===`${pins.currentMainCommit} ${e.CLOSED_CARRIER_PARENT}`,'source_identity_invalid');
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
try {
 bind();clockGuard(true);await currentMain();clockGuard(true);
 mkdirSync('acceptance-results',{recursive:true});
 writeFileSync('acceptance-results/cleanup-preflight.json',JSON.stringify({version:1,status:'passed',operatorCommit:process.env.GITHUB_SHA,operatorTree:git('rev-parse','HEAD^{tree}'),parent:pins.currentMainCommit,parentTree:pins.currentMainTree,helperSha256:HELPER_SHA,freshScopeReceiptSha256:pins.freshScopeReceiptSha256,actualEntryAt:new Date().toISOString(),hardEndAt:pins.hardEndAt},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({status:'passed',stage:'before_oidc'}));
} catch(error) {saveClosed(failCode(error));}

// Executes only exact synchronous guard fragments supplied by validate.py.
// All Git responses and credentials are synthetic; fetch is a throwing sentinel.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const input=JSON.parse(readFileSync(process.argv[2],'utf8'));
const A='1'.repeat(40), T='2'.repeat(40), C='3'.repeat(40), H='4'.repeat(40), OTHER='5'.repeat(40);
const trusted='ops/1505-smoke-github-readonly-20261109';
const result=[];
function expect(name,fn,code=null){
  if(code)assert.throws(fn,error=>(error.cleanupGuardCode??error.message)===code,name);
  else fn();
  result.push({name,status:'passed',expectedRefusal:code});
}
function prepare(which,options={}){
  const source=input.prepare[which];
  const e={EXPECTED_APP_SOURCE:A,EXPECTED_APP_TREE:T,HELPER_PARENT:A,HELPER_PARENT_TREE:T,
    CLOSED_CARRIER_PARENT:C,HELPER_SHA256:'6'.repeat(64),UPSTREAM_RUNTIME_SOURCE:OTHER,
    UPSTREAM_RUN_ID:'1',UPSTREAM_ATTEMPT:'1',DIAGNOSTIC_WINDOW_GO:source.go,
    NOT_BEFORE:'2020-01-01T00:00:00Z',ENTRY_DEADLINE:'2020-01-01T00:05:00Z',HARD_DEADLINE:'2020-01-01T00:15:00Z',
    GITHUB_REPOSITORY:'alexj11324/Mikka',GITHUB_REF:'refs/heads/'+source.branch,
    GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:H,...options.env};
  const parents=options.parents??[A,C];
  const context={e,branch:source.branch,go:source.go,opsDir:'/synthetic-ops',
    check:(ok,code)=>{if(!ok)throw new Error(code);},
    git:(directory,...args)=>{
      assert.equal(directory,'/synthetic-ops');
      if(JSON.stringify(args)===JSON.stringify(['rev-list','--parents','-n','1','HEAD']))return [H,...parents].join(' ');
      if(JSON.stringify(args)===JSON.stringify(['rev-parse',A+'^{tree}']))return options.tree??T;
      throw new Error('unexpected_git_request');
    },fetch:()=>{throw new Error('network_forbidden');}};
  vm.runInNewContext(source.pinValidation+'\npinValidation();\n'+source.parents,context,{timeout:1000});
}
function cleanup(which,options={}){
  const source=input.cleanup[which];
  const pins={version:1,baseCommit:A,baseTree:T,currentMainCommit:A,currentMainTree:T,
    freshScopeReceiptSha256:'6'.repeat(64),diagnosticEnvId:'synthetic-owned-id',diagnosticValueSha256:'7'.repeat(64),
    diagnosticExpiresAt:'2020-01-01T02:00:00.000Z',startAt:'2020-01-01T00:00:00.000Z',
    latestEntryAt:'2020-01-01T00:05:00.000Z',hardEndAt:'2020-01-01T00:15:00.000Z',rootReviewGo:source.go};
  const e={CLEANUP_BINDINGS_JSON:JSON.stringify(pins),CLOSED_CARRIER_PARENT:C,
    GITHUB_REPOSITORY:'alexj11324/Mikka',GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/'+source.branch,
    GITHUB_WORKFLOW_REF:'alexj11324/Mikka/'+source.workflowPath+'@refs/heads/'+source.branch,
    GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:H,GITHUB_TOKEN:'synthetic-not-a-credential',...options.env};
  const parents=options.parents??[A,C];
  const allowed=[source.workflowPath,source.helperPath];
  const helper=readFileSync(new URL('./cleanup/scripts/ops/issue1505-diagnostic-cleanup-r7.mjs',import.meta.url));
  const context={process:{env:e},createHash,JSON,
    readFileSync:path=>{assert.equal(path,source.helperPath);return helper;},
    git:(...args)=>{
      const key=JSON.stringify(args);
      if(key===JSON.stringify(['rev-parse','HEAD']))return H;
      if(key===JSON.stringify(['show','-s','--format=%P','HEAD']))return parents.join(' ');
      if(key===JSON.stringify(['rev-parse',A+'^{tree}']))return options.tree??T;
      if(key===JSON.stringify(['diff-tree','--no-commit-id','--name-status','--no-renames','-r',A,'HEAD']))
        return options.delta??allowed.map(path=>'A\t'+path).join('\n');
      if(args[0]==='ls-tree'&&args[1]==='HEAD'&&args[2]==='--'&&allowed.includes(args[3]))
        return (options.mode??'100644')+' blob '+OTHER+'\t'+args[3];
      if(key===JSON.stringify(['status','--porcelain=v1','--untracked-files=no']))return '';
      if(key===JSON.stringify(['rev-parse','HEAD:'+source.helperPath]))return input.cleanupHelperBlob;
      throw new Error('unexpected_git_request');
    },fetch:()=>{throw new Error('network_forbidden');}};
  vm.runInNewContext(source.prefix+'\n'+source.bind+'\nbind();',context,{timeout:1000});
}

expect('original prepare rejects ordered APP/carrier parents',()=>prepare('original'),'helper_parent_mismatch');
expect('original cleanup rejects ordered APP/carrier parents',()=>cleanup('original'),'source_identity_invalid');
expect('trusted prepare accepts exact ordered parents',()=>prepare('candidate'));
expect('trusted cleanup accepts exact ordered parents',()=>cleanup('candidate'));
for(const [name,parents] of [['single parent',[A]],['reversed parents',[C,A]],['third parent',[A,C,OTHER]],['wrong carrier',[A,OTHER]]]){
  expect('prepare rejects '+name,()=>prepare('candidate',{parents}),'helper_parent_mismatch');
  expect('cleanup rejects '+name,()=>cleanup('candidate',{parents}),'source_identity_invalid');
}
for(const [name,value] of [['unfilled carrier',''],['APP reused as carrier',A]]){
  expect('prepare rejects '+name,()=>prepare('candidate',{env:{CLOSED_CARRIER_PARENT:value}}),'carrier_parent_invalid');
  expect('cleanup rejects '+name,()=>cleanup('candidate',{env:{CLOSED_CARRIER_PARENT:value}}),'bindings_invalid');
}
expect('prepare rejects former unproven branch',()=>prepare('candidate',{env:{GITHUB_REF:'refs/heads/'+input.prepare.original.branch}}),'workflow_identity_invalid');
expect('cleanup rejects former unproven branch',()=>cleanup('candidate',{env:{GITHUB_REF:'refs/heads/'+input.cleanup.original.branch}}),'execution_identity_invalid');
expect('prepare still checks APP tree',()=>prepare('candidate',{tree:OTHER}),'helper_parent_tree_mismatch');
expect('cleanup still checks APP tree',()=>cleanup('candidate',{tree:OTHER}),'source_identity_invalid');
expect('cleanup rejects carrier content outside the two APP additions',()=>cleanup('candidate',{delta:'A\tforeign-carrier-workflow.yml'}),'source_delta_invalid');
expect('cleanup rejects executable additions',()=>cleanup('candidate',{mode:'100755'}),'source_delta_invalid');
assert.equal(input.prepare.candidate.branch,trusted);
assert.equal(input.cleanup.candidate.branch,trusted);
console.log(JSON.stringify({status:'passed',scope:'offline extracted synchronous branch/parent guards only',
  checks:result.length,results:result,networkCalls:0,gitSubprocesses:0,helperBusinessCalls:0,
  actualOidcOrSourceTreeValidated:false},null,2));

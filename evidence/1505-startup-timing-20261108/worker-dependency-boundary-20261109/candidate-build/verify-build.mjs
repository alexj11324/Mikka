import assert from 'node:assert/strict';
import {accessSync,constants,readFileSync,readdirSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const [cwd, release, marker, reportPath] = process.argv.slice(2);
const out=cwd+'/packages/daemon/dist/cloud';
const expectedHead='e73f12c072786786883ba932689fc00cc8e2ea71';
const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
assert.equal(git('rev-parse','HEAD'),expectedHead);
assert.equal(execFileSync('python3',['scripts/e2b/build-template.py','--worker-hash','--source-ref',expectedHead],{cwd,encoding:'utf8'}).trim(),marker);
const sha=b=>createHash('sha256').update(b).digest('hex');
const file=p=>({bytes:statSync(p).size,sha256:sha(readFileSync(p)),mode:(statSync(p).mode&0o777).toString(8)});
const req=createRequire(cwd+'/packages/daemon/package.json');
const sdk=createRequire(req.resolve('@anthropic-ai/claude-agent-sdk'));
const cli=realpathSync(sdk.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/package.json')).replace(/package\.json$/,'claude');
assert(cli.startsWith(release+'/install/'));
accessSync(cli,constants.R_OK|constants.X_OK);
const pino=realpathSync(req.resolve('pino')); assert(pino.startsWith(release+'/install/'));
const esbuild=realpathSync(req.resolve('esbuild')); assert(esbuild.startsWith(release+'/install/'));
const copiedResources=[];
for (const rel of ['agents/native-container.mjs','computer/proxy.mjs','computer/driver.mjs']) {
 const src=cwd+'/packages/daemon/src/'+rel,dst=out+'/'+rel;
 assert(readFileSync(src).equals(readFileSync(dst)));copiedResources.push({source:src,output:dst,...file(dst)});
}
for(const rel of ['mikka-mcp.mjs','mikka-mcp-context.mjs','mikka-mcp-backend.mjs','mikka-mcp-worker.mjs','capture-copy.mjs','github-credentials.mjs']) {
 const src=cwd+'/packages/daemon/src/agents/'+rel,dst=out+'/'+rel;
 assert(readFileSync(src).equals(readFileSync(dst)));copiedResources.push({source:src,output:dst,...file(dst)});
}
const {WORKER_BOOTSTRAP_BROKER_SOURCE}=await import(pathToFileURL(cwd+'/packages/daemon/src/cloud-bootstrap-broker.mjs'));
const broker=out+'/bootstrap-broker.mjs';
assert.equal(readFileSync(broker,'utf8'),WORKER_BOOTSTRAP_BROKER_SOURCE);assert.equal(statSync(broker).mode&0o777,0o444);
const capability=out+'/runtime-capabilities.json';
assert.deepEqual(JSON.parse(readFileSync(capability,'utf8')),{registrationNoticeVersion:1,workerSha:marker});assert.equal(statSync(capability).mode&0o777,0o444);
const walk=(base,rel='')=>readdirSync(base+'/'+rel,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{
 const p=rel?rel+'/'+e.name:e.name;return e.isDirectory()?walk(base,p):[{path:p,...file(base+'/'+p)}];
});
const fixtures=walk(cwd+'/packages/daemon/fixtures');assert.deepEqual(walk(out+'/fixtures'),fixtures);
const outputs=['cloud-worker.js','cloud-model-probe.js'].map(rel=>({path:rel,...file(out+'/'+rel)}));
const syntax=[];
for(const path of [...outputs.map(x=>out+'/'+x.path),...copiedResources.map(x=>x.output),broker]) {
 const r=spawnSync(process.execPath,['--check',path],{cwd,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);
 syntax.push({path,exitCode:r.status});
}
const result={verifiedAt:new Date().toISOString(),workerHash:marker,canonicalCandidateHashClaimed:true,head:expectedHead,tree:git('rev-parse','HEAD^{tree}'),cwd,dependencyRelease:release,
 cliRelative:cli.slice(release.length+1),cliReadableExecutable:true,pinoRelative:pino.slice(release.length+1),
 esbuildRelative:esbuild.slice(release.length+1),outputs,copiedResources,fixtures,syntax,
 broker:{...file(broker),exactSourceMatch:true},capability:{...file(capability)},
 noModels:true,noE2B:true,limitations:['Local Node 24.22.1, template Node 24.19.0','Actual template/CLI conservation/native subscription gates not executed']};
writeFileSync(reportPath,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({entries:outputs.length,resources:copiedResources.length,fixtures:fixtures.length,syntax:syntax.length,cliRelative:result.cliRelative,pinoRelative:result.pinoRelative,sha256:sha(readFileSync(reportPath))}));

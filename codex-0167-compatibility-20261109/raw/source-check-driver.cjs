
const fs=require("node:fs"),cp=require("node:child_process"),crypto=require("node:crypto");
const root="/vercel/sandbox/issue1505-codex0167",repo=root+"/repo",out=root+"/evidence";
const changed=["docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md","packages/daemon/src/anonymous-codex-spare.ts","packages/daemon/test/anonymous-codex-hosted.test.ts","packages/daemon/test/anonymous-codex-spare.test.ts"];
fs.writeFileSync(out+"/checked-files.json",JSON.stringify(changed.map(path=>{const b=fs.readFileSync(repo+"/"+path);return {path,bytes:b.length,sha256:crypto.createHash("sha256").update(b).digest("hex")}}),null,2)+"\n");
async function run(name,args,timeout){
 const started=new Date().toISOString();
 const stdout=fs.createWriteStream(out+"/"+name+".stdout.txt"),stderr=fs.createWriteStream(out+"/"+name+".stderr.txt");
 const child=cp.spawn("corepack",args,{cwd:repo,env:{...process.env,CI:"1"},stdio:["ignore","pipe","pipe"],timeout});
 child.stdout.pipe(stdout);child.stderr.pipe(stderr);let errorCode;child.on("error",e=>errorCode=e.code);
 const result=await new Promise(resolve=>child.on("close",(exitCode,signal)=>resolve({name,command:"corepack",args,started,ended:new Date().toISOString(),exitCode,signal,errorCode})));
 await Promise.all([new Promise(r=>stdout.end(r)),new Promise(r=>stderr.end(r))]);
 fs.writeFileSync(out+"/"+name+".result.json",JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));return result;
}
(async()=>{
 const results=await Promise.all([
  run("source-check",["pnpm","check"],600000),
  run("changed-lint",["pnpm","exec","oxlint","--deny-warnings","packages/daemon/src/anonymous-codex-spare.ts","packages/daemon/test/anonymous-codex-spare.test.ts","packages/daemon/test/anonymous-codex-hosted.test.ts"],120000)
 ]);
 if(results.some(r=>r.exitCode!==0))process.exitCode=1;
})().catch(e=>{console.error(String(e));process.exitCode=1});

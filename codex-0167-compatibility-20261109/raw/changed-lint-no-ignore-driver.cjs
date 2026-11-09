
const fs=require("node:fs"),cp=require("node:child_process");
const root="/vercel/sandbox/issue1505-codex0167",repo=root+"/repo",out=root+"/evidence";
const args=["pnpm","exec","oxlint","--no-ignore","--deny-warnings","packages/daemon/src/anonymous-codex-spare.ts","packages/daemon/test/anonymous-codex-spare.test.ts","packages/daemon/test/anonymous-codex-hosted.test.ts"];
const started=new Date().toISOString();const r=cp.spawnSync("corepack",args,{cwd:repo,encoding:"utf8",timeout:45000,env:{...process.env,CI:"1"}});
fs.writeFileSync(out+"/changed-lint-no-ignore.stdout.txt",r.stdout||"");fs.writeFileSync(out+"/changed-lint-no-ignore.stderr.txt",r.stderr||"");
const record={command:"corepack",args,started,ended:new Date().toISOString(),exitCode:r.status,signal:r.signal};
fs.writeFileSync(out+"/changed-lint-no-ignore.result.json",JSON.stringify(record,null,2)+"\n");
console.log(JSON.stringify(record));console.log(r.stdout);console.log(r.stderr);if(r.status!==0)process.exitCode=1;

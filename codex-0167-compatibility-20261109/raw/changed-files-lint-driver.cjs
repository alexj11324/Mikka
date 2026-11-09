
const fs=require("node:fs"),cp=require("node:child_process"),crypto=require("node:crypto");
const root="/vercel/sandbox/issue1505-codex0167",repo=root+"/repo",out=root+"/evidence";
const hosted=repo+"/packages/daemon/test/anonymous-codex-hosted.test.ts";
const before="// Native initialize/config semantics are separately verified for the supported versions.";
const after="// Native initialize/config contracts are compared separately at fixed upstream commits.";
const s=fs.readFileSync(hosted,"utf8");if(!s.includes(before))throw Error("comment base mismatch");fs.writeFileSync(hosted,s.replace(before,after));
const original=JSON.parse(fs.readFileSync(repo+"/.oxlintrc.json","utf8"));
const projected={...original,ignorePatterns:[]};const config=out+"/changed-files.oxlint.json";
fs.writeFileSync(config,JSON.stringify(projected,null,2)+"\n");
const args=["pnpm","exec","oxlint","-c",config,"--deny-warnings","packages/daemon/src/anonymous-codex-spare.ts","packages/daemon/test/anonymous-codex-spare.test.ts","packages/daemon/test/anonymous-codex-hosted.test.ts"];
const started=new Date().toISOString();const r=cp.spawnSync("corepack",args,{cwd:repo,encoding:"utf8",timeout:45000,env:{...process.env,CI:"1"}});
fs.writeFileSync(out+"/changed-files-lint.stdout.txt",r.stdout||"");fs.writeFileSync(out+"/changed-files-lint.stderr.txt",r.stderr||"");
const record={command:"corepack",args,started,ended:new Date().toISOString(),exitCode:r.status,signal:r.signal,configDifference:"ignorePatterns=[] only; all root rules retained",hostedCommentSha256:crypto.createHash("sha256").update(fs.readFileSync(hosted)).digest("hex")};
fs.writeFileSync(out+"/changed-files-lint.result.json",JSON.stringify(record,null,2)+"\n");
console.log(JSON.stringify(record));console.log(r.stdout);console.log(r.stderr);if(r.status!==0)process.exitCode=1;

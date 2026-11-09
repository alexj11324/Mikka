
const fs=require("node:fs"),cp=require("node:child_process"),crypto=require("node:crypto");
const root="/vercel/sandbox/issue1505-codex0167",repo=root+"/repo",out=root+"/evidence";
const sourcePath="packages/daemon/src/anonymous-codex-spare.ts",sha=crypto.createHash("sha256").update(fs.readFileSync(repo+"/"+sourcePath)).digest("hex");
if(sha!=="f9c3e82ea67e6a57cf53ef1978c861a7d127cd039e79e2bd9a7da5fd81fcb3ea")throw Error("fixed source mismatch");
const args=["node_modules/vitest/vitest.mjs","run","test/anonymous-codex-spare.test.ts","test/anonymous-codex-hosted.test.ts","test/codex-startup-config.test.ts","--reporter=json","--outputFile="+out+"/green.report.json"];
const started=new Date().toISOString();
const p=cp.spawnSync(process.execPath,args,{cwd:repo+"/packages/daemon",encoding:"utf8",timeout:180000,env:{...process.env,CI:"1"}});
fs.writeFileSync(out+"/green.stdout.txt",p.stdout||"");fs.writeFileSync(out+"/green.stderr.txt",p.stderr||"");
const report=JSON.parse(fs.readFileSync(out+"/green.report.json","utf8"));
const failures=report.testResults.flatMap(s=>s.assertionResults.filter(a=>a.status==="failed").map(a=>({name:a.fullName,failureMessages:a.failureMessages})));
const record={base:"12458fe22e1217f644e8b28f82ab856211e73b72",sourcePath,sourceSha256:sha,args,started,ended:new Date().toISOString(),exitCode:p.status,signal:p.signal,numPassedTests:report.numPassedTests,numFailedTests:report.numFailedTests,numPendingTests:report.numPendingTests,failures};
fs.writeFileSync(out+"/green.result.json",JSON.stringify(record,null,2)+"\n");console.log(JSON.stringify(record));
if(p.status!==0||report.numFailedTests!==0||report.numPendingTests!==0)throw Error("unexpected green outcome");

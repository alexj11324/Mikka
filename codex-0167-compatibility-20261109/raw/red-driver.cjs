
const fs=require("node:fs"),cp=require("node:child_process"),crypto=require("node:crypto");
const root="/vercel/sandbox/issue1505-codex0167",repo=root+"/repo",out=root+"/evidence";
const digest=b=>crypto.createHash("sha256").update(b).digest("hex");
const manifest=[{"path":"packages/daemon/test/anonymous-codex-spare.test.ts","baseSha256":"8edb0a30583ed610f9ad385830ec444ba73f69eb38df6b3931bbe1e247f8f8a9","bytes":15067,"sha256":"4ff047f7ddfbca99d6ac0b4b5b4524e5b90df7b041e81855242d5cd7acaaed06"},{"path":"packages/daemon/test/anonymous-codex-hosted.test.ts","baseSha256":"3730a8b054fe913d8075dc510c188c66d2cfcadb51f8868beca2e633a3d824d0","bytes":13541,"sha256":"d846808088972c0796855bb1bac515ec0b3feefa942b38c0a620cc5b28ebb648"}];
for(const f of manifest){
 if(digest(fs.readFileSync(repo+"/"+f.path))!==f.sha256)throw Error("fixture transfer mismatch");
 const base=cp.execFileSync("git",["show","HEAD:"+f.path],{cwd:repo});
 if(digest(base)!==f.baseSha256)throw Error("fixture base mismatch");
}
const sourcePath="packages/daemon/src/anonymous-codex-spare.ts",sha=digest(fs.readFileSync(repo+"/"+sourcePath));
if(sha!=="b7fac1b0fadd1374377ba27b9fe62d60a70a746218fe029237acf870855d6035")throw Error("baseline source mismatch");
const args=["node_modules/vitest/vitest.mjs","run","test/anonymous-codex-spare.test.ts","test/anonymous-codex-hosted.test.ts","--reporter=json","--outputFile="+out+"/red.report.json"];
const started=new Date().toISOString();
const p=cp.spawnSync(process.execPath,args,{cwd:repo+"/packages/daemon",encoding:"utf8",timeout:180000,env:{...process.env,CI:"1"}});
fs.writeFileSync(out+"/red.stdout.txt",p.stdout||"");fs.writeFileSync(out+"/red.stderr.txt",p.stderr||"");
const report=JSON.parse(fs.readFileSync(out+"/red.report.json","utf8"));
const failures=report.testResults.flatMap(s=>s.assertionResults.filter(a=>a.status==="failed").map(a=>({name:a.fullName,failureMessages:a.failureMessages})));
const record={source:"12458fe22e1217f644e8b28f82ab856211e73b72",sourcePath,sourceSha256:sha,args,started,ended:new Date().toISOString(),exitCode:p.status,signal:p.signal,numPassedTests:report.numPassedTests,numFailedTests:report.numFailedTests,numPendingTests:report.numPendingTests,failures};
fs.writeFileSync(out+"/red.result.json",JSON.stringify(record,null,2)+"\n");console.log(JSON.stringify(record));
if(p.status!==1||report.numFailedTests!==3||report.numPendingTests!==0||failures.some(f=>!f.name.includes("0.167.0")||!f.failureMessages.some(x=>x.includes("Anonymous Codex version unavailable"))))throw Error("unexpected red outcome");

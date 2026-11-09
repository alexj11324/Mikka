
const fs=require("node:fs"),cp=require("node:child_process"),crypto=require("node:crypto");
const root="/vercel/sandbox/issue1505-codex0167",repo=root+"/repo",out=root+"/evidence";
const adr=repo+"/docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md";
const a=fs.readFileSync(adr,"utf8"),before="bootstrap adoption 完整通过；Codex 的真实工具、工具后回复、OAuth 和\nruntime evidence 通过，但 `template_gate_bootstrap_adoption_missing`",after="bootstrap adoption 完整通过；Codex 的共享订阅执行、真实工具、工具后\n回复及 runtime evidence 通过，但 `template_gate_bootstrap_adoption_missing`";
if(!a.includes(before))throw Error("ADR base mismatch");fs.writeFileSync(adr,a.replace(before,after));
const paths=["docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md","packages/daemon/src/anonymous-codex-spare.ts","packages/daemon/test/anonymous-codex-hosted.test.ts","packages/daemon/test/anonymous-codex-spare.test.ts"];
const digest=b=>crypto.createHash("sha256").update(b).digest("hex");
fs.writeFileSync(out+"/final-files.json",JSON.stringify(paths.map(path=>{const b=fs.readFileSync(repo+"/"+path);return{path,bytes:b.length,sha256:digest(b)}}),null,2)+"\n");
const red=JSON.parse(fs.readFileSync(out+"/red.result.json")),green=JSON.parse(fs.readFileSync(out+"/green.result.json")),types=JSON.parse(fs.readFileSync(out+"/typecheck.result.json")),check=JSON.parse(fs.readFileSync(out+"/source-check.result.json")),lint=JSON.parse(fs.readFileSync(out+"/changed-files-lint.result.json"));
const raw=fs.readFileSync(out+"/source-check.stdout.txt","utf8");
const summary={red:{passed:red.numPassedTests,failed:red.numFailedTests,skipped:red.numPendingTests},green:{passed:green.numPassedTests,failed:green.numFailedTests,skipped:green.numPendingTests},typecheck:types.exitCode,sourceCheck:{exitCode:check.exitCode,localPostgresRefused:raw.includes("ECONNREFUSED 127.0.0.1:5432"),dbProvisioned:false},lint:lint.exitCode,postValidationChanges:"hosted test explanatory comment and ADR subscription wording only; no rerun of runtime tests"};
fs.writeFileSync(out+"/summary.json",JSON.stringify(summary,null,2)+"\n");
const manifest=fs.readdirSync(out).sort().map(name=>{const p=out+"/"+name;const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink())throw Error("unexpected evidence node");const b=fs.readFileSync(p);return{path:name,bytes:b.length,sha256:digest(b)}});
fs.writeFileSync(root+"/evidence-manifest.json",JSON.stringify(manifest,null,2)+"\n");
cp.execFileSync("tar",["-czf",root+"/evidence.tar.gz","-C",root,"evidence","evidence-manifest.json"]);
const b=fs.readFileSync(root+"/evidence.tar.gz");console.log(JSON.stringify({archive:root+"/evidence.tar.gz",bytes:b.length,sha256:digest(b),files:manifest.length,summary}));

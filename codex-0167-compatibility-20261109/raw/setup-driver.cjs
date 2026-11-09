
const fs=require("node:fs"),cp=require("node:child_process"),path=require("node:path");
const root="/vercel/sandbox/issue1505-codex0167",repo=root+"/repo",evidence=root+"/evidence";
fs.mkdirSync(evidence,{recursive:true});
const forbidden=["SMOKE_OWNER_EMAIL","SMOKE_OWNER_PASSWORD","DATABASE_URL","MIKKA_DATABASE_URL","INFISICAL_CLIENT_SECRET","INFISICAL_TOKEN","E2B_API_KEY","GITHUB_TOKEN","GH_TOKEN","VERCEL_TOKEN","VERCEL_OIDC_TOKEN","OPENAI_API_KEY","ANTHROPIC_API_KEY","CODEX_ACCESS_TOKEN","CLAUDE_CODE_OAUTH_TOKEN"];
if(forbidden.some(k=>process.env[k]))throw Error("unexpected credential environment");
if(process.platform!=="linux"||process.getuid()===0)throw Error("non-root Linux required");
if(["/etc/codex/config.toml","/etc/codex/requirements.toml","/tmp/.codex"].some(p=>fs.existsSync(p)))throw Error("clean fixture host required");
fs.writeFileSync(evidence+"/environment.json",JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,uid:process.getuid(),productionCredentialsAbsent:true,systemCodexConfigAbsent:true},null,2)+"\n");
async function run(name,command,args,cwd=root,timeout=300000){
 const began=new Date().toISOString(),start=performance.now();
 const child=cp.spawn(command,args,{cwd,env:{...process.env,CI:"1"},stdio:["ignore","pipe","pipe"],timeout});
 let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
 let error;child.on("error",e=>error=e.code);
 const r=await new Promise(resolve=>child.on("close",(code,signal)=>resolve({name,command,args,cwd,began,ended:new Date().toISOString(),ms:performance.now()-start,code,signal,error})));
 fs.writeFileSync(evidence+"/"+name+".stdout.txt",stdout);fs.writeFileSync(evidence+"/"+name+".stderr.txt",stderr);fs.writeFileSync(evidence+"/"+name+".json",JSON.stringify(r,null,2)+"\n");
 console.log(JSON.stringify({name,code:r.code,signal:r.signal,error}));if(r.code!==0)throw Error(name+" failed");return r;
}
(async()=>{
 await run("git-init","git",["init",repo]);
 await run("git-remote","git",["remote","add","origin","https://github.com/alexj11324/Mikka.git"],repo);
 await run("git-fetch","git",["fetch","--depth=1","--no-tags","origin","12458fe22e1217f644e8b28f82ab856211e73b72"],repo);
 await run("git-checkout","git",["checkout","--detach","FETCH_HEAD"],repo);
 const rev=cp.execFileSync("git",["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim();
 const tree=cp.execFileSync("git",["rev-parse","HEAD^{tree}"],{cwd:repo,encoding:"utf8"}).trim();
 if(rev!=="12458fe22e1217f644e8b28f82ab856211e73b72"||tree!=="3f804659ce05591aefb6d080ea873ba88e32ad46")throw Error("source mismatch");
 fs.writeFileSync(evidence+"/source.json",JSON.stringify({rev,tree},null,2)+"\n");
 const has=cp.spawnSync("corepack",["--version"],{encoding:"utf8"}).status===0;
 const command=has?"corepack":"npx",prefix=has?["pnpm"]:["--yes","pnpm@10.34.3"];
 await run("pnpm-version",command,[...prefix,"--version"],repo);
 await run("filtered-frozen-install",command,[...prefix,"--filter","@mikka/daemon...","install","--frozen-lockfile","--ignore-scripts"],repo,540000);
 console.log(JSON.stringify({setup:"ready",source:rev,tree}));
})().catch(e=>{console.error(String(e));process.exitCode=1});

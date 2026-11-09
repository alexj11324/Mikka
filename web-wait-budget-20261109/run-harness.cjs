const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),p=JSON.parse(process.argv[1]);
const expanded=fs.readFileSync('scripts/release/web-deploy.test.mjs','utf8');
const orig=JSON.parse(fs.readFileSync('source.json','utf8'));
for(const [f,s]of Object.entries(orig)){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s)}
fs.mkdirSync('docs/operations',{recursive:true});fs.writeFileSync('docs/operations/web-deploy.md',p.oldDoc);
const git=args=>cp.execFileSync('git',args,{encoding:'utf8'});
git(['init','-q','-b','main']);git(['add','scripts','.github','docs']);git(['-c','user.name=Release fixture','-c','user.email=release@example.invalid','commit','-qm','Pinned 37ff source fixture']);
fs.writeFileSync('scripts/release/web-deploy.test.mjs',expanded);fs.writeFileSync('scripts/release/web-deploy.mjs',p.red);fs.writeFileSync('red-source.mjs',p.red);
function run(label){const r=cp.spawnSync(process.execPath,['--test','--test-reporter=spec','scripts/release/web-deploy.test.mjs'],{encoding:'utf8',timeout:90000,maxBuffer:8e6});const out=(r.stdout||'')+(r.stderr||'');fs.writeFileSync(label+'.log',out);const m={node:process.version,status:r.status,signal:r.signal,error:r.error?.message,bytes:Buffer.byteLength(out),sha256:crypto.createHash('sha256').update(out).digest('hex')};fs.writeFileSync(label+'.json',JSON.stringify(m,null,2)+'\n');console.log(JSON.stringify({label,...m}));console.log(out.slice(-1250));return r.status;}
const red=run('red');if(red!==1)throw Error('Expected genuine old-budget test failures');
fs.writeFileSync('scripts/release/web-deploy.mjs',p.green);fs.writeFileSync('green-source.mjs',p.green);fs.writeFileSync('.github/workflows/e2b-official-runtime.yml',p.workflow);fs.writeFileSync('docs/operations/web-deploy.md',p.doc);
const green=run('green');
const diffCheck=cp.spawnSync('git',['diff','--check'],{encoding:'utf8'});const diff=git(['diff','--stat']);fs.writeFileSync('diff.patch',git(['diff']));fs.writeFileSync('diff-check.log',(diffCheck.stdout||'')+(diffCheck.stderr||'')+diff);
const inventory=['scripts/release/web-deploy.mjs','scripts/release/web-deploy.test.mjs','.github/workflows/e2b-official-runtime.yml','docs/operations/web-deploy.md'].map(f=>{const b=fs.readFileSync(f);return {path:f,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}});
fs.writeFileSync('changed-manifest.json',JSON.stringify(inventory,null,2)+'\n');console.log(JSON.stringify({diffCheck:diffCheck.status,inventory}));console.log(diff);if(green!==0||diffCheck.status!==0)process.exit(1);

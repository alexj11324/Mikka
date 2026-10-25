import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
const require=createRequire('/workspace/mikka-policy-runtime-710/package.json');
const {Pool}=require('pg');
const run=promisify(execFile), origin='http://127.0.0.1:3130';
const original=JSON.parse(await readFile('/tmp/policy-230-http-80/acceptance.json','utf8'));
const tenant=original.versions.find(v=>v.version===4).workspace_id;
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.ok(url.pathname.endsWith('_e2e'));
const jar=new Map(),receipts=[];
async function request(path,body){const headers={};if(jar.size)headers.cookie=[...jar].map(([k,v])=>`${k}=${v}`).join('; ');if(body){headers.origin=origin;headers['content-type']='application/json'}const r=await fetch(origin+'/mikka'+path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});for(const line of r.headers.getSetCookie()){const pair=line.split(';',1)[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1))}const data=await r.json();receipts.push({path,status:r.status,utc:new Date().toISOString()});return {r,data}}
try{
const signup=await request('/api/auth/sign-up/email',{name:'Synthetic restart probe',email:`restart-${randomUUID()}@example.invalid`,password:randomBytes(32).toString('base64url')});assert.equal(signup.r.status,200);
await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Synthetic','restart@example.invalid','member')`,[tenant,signup.data.user.id]);
const before=await request(`/api/policy?workspaceId=${tenant}`);assert.equal(before.r.status,200);assert.equal(before.data.signed.payload.version,4);
await run('docker',['--host=unix:///var/run/docker.sock','stop','--timeout','10','mikka-policy-710-runtime']);await run('docker',['--host=unix:///var/run/docker.sock','start','mikka-policy-710-runtime']);
let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/mikka/api/policy')).status===401){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,500))}assert.ok(ready);
const after=await request(`/api/policy?workspaceId=${tenant}`);assert.equal(after.r.status,200);assert.deepEqual(after.data.signed,before.data.signed);
await writeFile('/tmp/policy-230-http-80/restart-acceptance.json',JSON.stringify({sha:original.sha,utc:new Date().toISOString(),environment:'same frozen-source cloud Linux Next development runtime, process stopped and started; same isolated PG17; existing synthetic browser session',results:'passed',version:after.data.signed.payload.version,hash:after.data.signed.payload.hash,requests:receipts},null,2));
console.log(JSON.stringify({sha:original.sha,results:'passed',version:4,requests:receipts.length}));
}finally{await pool.end()}

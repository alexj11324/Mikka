import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const work = '/vercel/sandbox/mikka-1217-main40-integration';
const require = createRequire(work + '/package.json');
const { Pool } = require('pg');
const stamp = randomBytes(6).toString('hex');
const role = 'mikka_merge1217_' + stamp;
const database = role + '_e2e';
const password = randomBytes(24).toString('base64url');
const admin = new Pool({ connectionString: 'postgresql://mikka_test@127.0.0.1:5432/mikka_e2e', max: 1 });
const target = new URL('postgresql://127.0.0.1:5432/' + database);
target.username = role; target.password = password;
const env = Object.fromEntries(['PATH','HOME','LANG','TMPDIR'].filter(k => process.env[k] !== undefined).map(k => [k,process.env[k]]));
Object.assign(env, { TZ:'UTC', REQUIRE_DB:'1', E2E_DATABASE_URL:target.toString(), DATABASE_URL:target.toString(), MIKKA_DATABASE_URL:target.toString(), BETTER_AUTH_URL:'https://example.invalid', BETTER_AUTH_SECRET:randomBytes(32).toString('base64url') });
const logPrefix = '/tmp/mikka-1217-main40-pg-origin-fixed-';
const receipt = { head:'cccef174f7a4e604a820a4b61f8521e8cdba100b', main:'40d03479ea8260b8934f609b84c7c9cb60a94b3c', tree:'de3b83d85361e39a33ca9e5678d4ed37e6a33fe4', role, database, startedAt:new Date().toISOString(), gates:[], cleanup:null };
const save = () => writeFile(logPrefix + 'gates.json', JSON.stringify(receipt,null,2)+'\n');
let interrupted = false, child = null;
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => { interrupted = true; if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
async function gate(label, cmd, args, timeout=240000) {
 if (interrupted) throw new Error('interrupted');
 const handle = await open(logPrefix + label + '.log','w');
 const started = Date.now();
 child = spawn(cmd,args,{ cwd:work, env, stdio:['ignore',handle.fd,handle.fd] });
 const pid = child.pid;
 let timedOut = false;
 const timer = setTimeout(() => { timedOut=true; child?.kill('SIGTERM'); }, timeout);
 const killTimer = setTimeout(() => child?.kill('SIGKILL'), timeout+10000);
 const result = await new Promise((resolve,reject) => { child.on('error',reject); child.on('close',(code,signal)=>resolve({code,signal})); }).finally(()=>{clearTimeout(timer);clearTimeout(killTimer);});
 child = null; await handle.close();
 receipt.gates.push({label,cmd,args,pid,...result,timedOut,seconds:(Date.now()-started)/1000});
 await save();
 console.log(JSON.stringify({gate:label,...result,timedOut,seconds:(Date.now()-started)/1000}));
 if (interrupted) throw new Error('interrupted');
 return result.code === 0;
}
let app;
try {
 const ident = (await admin.query('SELECT current_user, current_database(), current_setting(\'server_version_num\') AS version')).rows[0];
 if (ident.current_database !== 'mikka_e2e' || Math.floor(Number(ident.version)/10000)!==17) throw new Error('unexpected local admin target');
 await admin.query('CREATE ROLE "'+role+'" WITH LOGIN CREATEDB PASSWORD \''+password+'\'');
 await admin.query('CREATE DATABASE "'+database+'" OWNER "'+role+'" TEMPLATE template0');
 app = new Pool({connectionString:target.toString(),max:1});
 const { orderMigrations } = await import(pathToFileURL(work+'/scripts/migration-order.mjs'));
 for (const file of orderMigrations((await readdir(work+'/drizzle')).filter(x=>x.endsWith('.sql')))) await app.query(await readFile(work+'/drizzle/'+file,'utf8'));
 await app.end(); app=null;
 await save();
 await gate('task-runtime-pg','node',['--experimental-test-module-mocks','--import','./scripts/server-test.mjs','--import','tsx','--test','--test-concurrency=1','lib/cloud-computer/thread-machine-task.db.test.ts','lib/cloud-computer/thread-machine-stop.db.test.ts','lib/computer/bot-runtime.db.test.ts','lib/computer/task-runtime.db.test.ts','tests/cloud-runtime-auto.db.test.ts','tests/run-provider-fallback-cloud.db.test.ts','tests/run-machine-fallback.db.test.ts','lib/factory/run-end-paths.db.test.ts']);
 await gate('factory-pg','corepack',['pnpm','test:factory-checks-db']);
} catch(error) {
 receipt.error={name:error?.name,code:error?.code??null,message:error?.message??String(error)};
 console.log(JSON.stringify({error:receipt.error}));
 process.exitCode=1;
} finally {
 if (app) await app.end().catch(()=>{});
 const owned = (await admin.query('SELECT datname FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname=$1',[role])).rows.map(x=>x.datname);
 for (const name of owned) {
  if (!/^[a-z0-9_]+_e2e$/.test(name)) throw new Error('unexpected owned database name');
  await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');
 }
 await admin.query('DROP ROLE IF EXISTS "'+role+'"');
 const databases = (await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[owned])).rows;
 const roles = (await admin.query('SELECT rolname FROM pg_roles WHERE rolname=$1',[role])).rows;
 receipt.cleanup={ownedDatabases:owned,databasesAbsent:databases.length===0,roleAbsent:roles.length===0};
 receipt.finishedAt=new Date().toISOString();
 await admin.end();
 await save();
 console.log(JSON.stringify({cleanup:receipt.cleanup,finishedAt:receipt.finishedAt}));
 if (receipt.gates.some(x=>x.code!==0)) process.exitCode=1;
}
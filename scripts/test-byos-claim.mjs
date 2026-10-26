import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
if(process.env.RETAIN_SYNTHETIC_RECORDS!=='1')throw Error('BYOS claim requires explicit retained synthetic fixtures')
let started=false
const name=`mikka-byos-claim-${randomUUID()}`
const env={PATH:process.env.PATH,LANG:'C.UTF-8'}
const run=(args)=>execFileSync('docker',args,{encoding:'utf8',env,stdio:['ignore','pipe','pipe']})
try {
 run(['run','-d','--name',name,'-p','127.0.0.1::5432','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=byos_claim_fixture','postgres:17-alpine'])
 started=true
 const port=run(['port',name,'5432/tcp']).trim().split(':').at(-1)
 let ready=false
 for(let i=0;i<60;i++){try{run(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']);ready=true;break}catch{await new Promise(r=>setTimeout(r,250))}}
 if(!ready)throw new Error('fixture unavailable')
 execFileSync(process.execPath,['--import','tsx','--test','--test-reporter=tap','lib/subscription-claim.test.ts'],{env:{...env,BYOS_CLAIM_TEST_DATABASE_URL:`postgresql://postgres@127.0.0.1:${port}/byos_claim_fixture`},stdio:'inherit'})
} finally {if(started){run(['stop',name]);console.log(JSON.stringify({fixture:'byos-claim',container:name,database:'byos_claim_fixture',disposition:'stopped-and-retained'}))}}

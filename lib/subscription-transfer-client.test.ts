import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EnrollmentClient, type EnrollmentConfiguration } from './subscription-enrollment'

// Real child IPC with synthetic leases; stdout returns only fixed error codes.
test('transfer errors invalidate only their own token role and other binds stay ordinary', async () => {
 const dir=await mkdtemp(join(tmpdir(),'mikka-transfer-client-')), binary=join(dir,'fixture.cjs')
 try {
  for (const denied of ['source_secret_store_denied','secret_store_denied']) {
   await writeFile(binary, `#!/usr/bin/env node\nlet s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const [c,r]=s.trim().split('\\n').map(JSON.parse);if(r.id==='other'){if(c.sourceToken||c.transferApproval)process.exit(2);console.log(JSON.stringify({error:'ordinary_bind'}));return}if(c.sourceToken!=='source-fixture'||c.workloadToken!=='destination-fixture')process.exit(3);console.log(JSON.stringify({error:${JSON.stringify(denied)}}))})`, {mode:0o700})
   let custodyRejected=0,sourceRejected=0,sourceIssued=0
   const config: EnrollmentConfiguration={binary,infisicalOrigin:'https://app.infisical.com',project:'fixture',environment:'prod',workloadToken:'',attemptPath:'/attempts',claimPath:'/claims',grantPath:'/pending',tokens:{get:async()=> 'destination-fixture',reject:()=>{custodyRejected++}},sourceTokens:{getAccessToken:async()=>{sourceIssued++;return 'source-fixture'},rejectAccessToken:()=>{sourceRejected++}},transferApproval:{enrollmentId:'approved'} as EnrollmentConfiguration['transferApproval']}
   const client=new EnrollmentClient(config)
   await assert.rejects(client.bind('operator','approved','owner','workspace'),/subscription_enrollment_unavailable/)
   assert.equal(custodyRejected,denied==='secret_store_denied'?1:0)
   assert.equal(sourceRejected,denied==='source_secret_store_denied'?1:0)
   await assert.rejects(client.bind('operator','other','owner','workspace'),/subscription_enrollment_unavailable/)
   assert.equal(sourceIssued,1)
  }
 } finally {await rm(dir,{recursive:true,force:true})}
})

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import test from 'node:test'
import {checkedApiPublication} from './load-cloudflare-api-receipt.mjs'

function fixture() {
  const source='a'.repeat(40),overlay='b'.repeat(40)
  const selection={API_RUN_ID:'123456',API_RUN_ATTEMPT:'2',API_IMAGE_DIGEST:'sha256:'+'c'.repeat(64),OVERLAY_SHA:overlay}
  const repository={id:1427517699,full_name:'alexj11324/Mikka',fork:false,private:false}
  const run={repository,head_repository:repository,path:'.github/workflows/cloudflare-api-image.yml',event:'workflow_dispatch',head_branch:'main',head_sha:source,status:'completed',conclusion:'success',actor:{id:183887963},triggering_actor:{id:183887963},id:123456,run_attempt:2}
  const jobs=[{name:'publish',run_id:123456,run_attempt:2,head_sha:source,status:'completed',conclusion:'success',steps:[
    'Compile and verify the API image offline','Verify the source checkout and publish the API image','Upload the API OCI receipt',
  ].map(name=>({name,conclusion:'success'}))}]
  const archive=Buffer.from('synthetic original artifact bytes')
  const artifact={name:'api-image-receipt-123456-2',expired:false,size_in_bytes:archive.length,digest:'sha256:'+createHash('sha256').update(archive).digest('hex'),workflow_run:{id:123456,repository_id:1427517699,head_repository_id:1427517699,head_branch:'main',head_sha:source}}
  const receipt={publicSha:source,workflowSha:source,runId:'123456',runAttempt:'2',digest:selection.API_IMAGE_DIGEST,privateSha:overlay}
  return {selection,run,jobs,artifact,archive,receipt}
}
const verify=f=>checkedApiPublication(f.run,f.jobs,f.artifact,f.archive,f.receipt,f.selection)

test('the original successful public API attempt and immutable upload bind the runtime source pair',()=>{
  const f=fixture()
  assert.equal(verify(f),f.receipt)
})

test('foreign source, owner, attempt, skipped gate and altered or expired artifact cannot replace the API receipt',()=>{
  for(const change of [
    f=>{f.run.head_branch='feature'},f=>{f.run.actor.id=1},f=>{f.run.run_attempt=1},
    f=>{f.jobs[0].steps[0].conclusion='skipped'},f=>{f.jobs[0].head_sha='d'.repeat(40)},
    f=>{f.artifact.expired=true},f=>{f.artifact.workflow_run.head_sha='d'.repeat(40)},
    f=>{f.archive=Buffer.from('altered artifact bytes')},f=>{f.receipt.publicSha='d'.repeat(40)},
    f=>{f.receipt.digest='sha256:'+'d'.repeat(64)},f=>{f.receipt.privateSha='d'.repeat(40)},
  ]){const f=fixture();change(f);assert.throws(()=>verify(f),{name:'AssertionError'})}
})

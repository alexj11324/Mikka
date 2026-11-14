import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {appendFile, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

const repository = 'alexj11324/Mikka'
const sha = /^[a-f0-9]{40}$/
const number = /^[1-9][0-9]{0,15}$/
const workflow = '.github/workflows/cloudflare-api-image.yml'
const steps = ['Compile and verify the API image offline','Verify the source checkout and publish the API image','Upload the API OCI receipt']

/** Consume the immutable original build receipt, rather than a mutable copy in
 * a GitHub Secret. The runtime publisher independently validates its payload. */
export function checkedApiPublication(run, jobs, artifact, archive, receipt, selection) {
  for (const field of ['repository','head_repository']) {
    assert.equal(run[field]?.id,1427517699)
    assert.equal(run[field].full_name,repository)
    assert.equal(run[field].private,false)
    assert.equal(run[field].fork,false)
  }
  assert.equal(run.path,workflow)
  assert.equal(run.event,'workflow_dispatch')
  assert.equal(run.head_branch,'main')
  assert.match(run.head_sha,sha)
  assert.equal(run.status,'completed')
  assert.equal(run.conclusion,'success')
  assert.equal(run.actor?.id,183887963)
  assert.equal(run.triggering_actor?.id,183887963)
  assert.equal(String(run.id),selection.API_RUN_ID)
  assert.equal(String(run.run_attempt),selection.API_RUN_ATTEMPT)
  const publishers = jobs.filter(job=>job.name==='publish')
  assert.equal(publishers.length,1)
  const [job] = publishers
  assert.equal(job.head_sha,run.head_sha)
  assert.equal(String(job.run_id),selection.API_RUN_ID)
  assert.equal(String(job.run_attempt),selection.API_RUN_ATTEMPT)
  assert.equal(job.status,'completed')
  assert.equal(job.conclusion,'success')
  for(const name of steps) assert.deepEqual(job.steps.filter(step=>step.name===name).map(step=>step.conclusion),['success'])
  assert.equal(artifact.name,`api-image-receipt-${selection.API_RUN_ID}-${selection.API_RUN_ATTEMPT}`)
  assert.equal(artifact.expired,false)
  assert.ok(artifact.size_in_bytes>0 && artifact.size_in_bytes<=2*1024*1024)
  assert.equal(archive.length,artifact.size_in_bytes)
  assert.equal(artifact.digest,'sha256:'+createHash('sha256').update(archive).digest('hex'))
  assert.equal(artifact.workflow_run?.id,Number(selection.API_RUN_ID))
  assert.equal(artifact.workflow_run?.repository_id,1427517699)
  assert.equal(artifact.workflow_run?.head_repository_id,1427517699)
  assert.equal(artifact.workflow_run?.head_branch,'main')
  assert.equal(artifact.workflow_run?.head_sha,run.head_sha)
  assert.equal(receipt.publicSha,run.head_sha)
  assert.equal(receipt.workflowSha,run.head_sha)
  assert.equal(receipt.runId,selection.API_RUN_ID)
  assert.equal(receipt.runAttempt,selection.API_RUN_ATTEMPT)
  assert.equal(receipt.digest,selection.API_IMAGE_DIGEST)
  assert.equal(receipt.privateSha,selection.OVERLAY_SHA)
  return receipt
}

async function load(env) {
  for(const name of ['API_RUN_ID','API_RUN_ATTEMPT']) assert.match(env[name]??'',number)
  assert.match(env.API_IMAGE_DIGEST??'',/^sha256:[a-f0-9]{64}$/)
  assert.match(env.OVERLAY_SHA??'',sha)
  assert.ok(env.GH_TOKEN && env.GITHUB_ENV)
  const headers={authorization:'Bearer '+env.GH_TOKEN,accept:'application/vnd.github+json','user-agent':'mikka-original-api-receipt'}
  const endpoint = path=>'https://api.github.com/repos/'+repository+'/'+path
  const json = async path=>{
    const r=await fetch(endpoint(path),{headers,redirect:'error',signal:AbortSignal.timeout(30000)})
    assert.equal(r.status,200,'Original API build metadata unavailable')
    return r.json()
  }
  const attempt=`actions/runs/${env.API_RUN_ID}/attempts/${env.API_RUN_ATTEMPT}`
  const run=await json(attempt)
  const first=await json(attempt+'/jobs?per_page=100')
  const jobs=[...first.jobs]
  for(let page=2;jobs.length<first.total_count;page++) {
    const next=await json(attempt+'/jobs?per_page=100&page='+page)
    assert.ok(next.jobs.length)
    jobs.push(...next.jobs)
  }
  const artifacts=[]
  for(let page=1;;page++) {
    const packet=await json(`actions/runs/${env.API_RUN_ID}/artifacts?per_page=100&page=${page}`)
    artifacts.push(...packet.artifacts)
    if(artifacts.length>=packet.total_count)break
    assert.ok(packet.artifacts.length)
  }
  const selected=artifacts.filter(a=>a.name===`api-image-receipt-${env.API_RUN_ID}-${env.API_RUN_ATTEMPT}`)
  assert.equal(selected.length,1,'Original API receipt is missing or ambiguous')
  const [artifact]=selected
  assert.ok(artifact.size_in_bytes>0 && artifact.size_in_bytes<=2*1024*1024)
  const link=await fetch(endpoint(`actions/artifacts/${artifact.id}/zip`),{headers,redirect:'manual',signal:AbortSignal.timeout(30000)})
  assert.equal(link.status,302)
  const target=new URL(link.headers.get('location'))
  assert.equal(target.protocol,'https:')
  assert.ok(!target.username && !target.password)
  assert.ok(target.hostname.endsWith('.blob.core.windows.net') || target.hostname.endsWith('.githubusercontent.com') || target.hostname.endsWith('.actions.githubusercontent.com'))
  const response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(60000)})
  assert.equal(response.status,200)
  const archive=Buffer.from(await response.arrayBuffer())
  assert.equal(archive.length,artifact.size_in_bytes)
  assert.equal(artifact.digest,'sha256:'+createHash('sha256').update(archive).digest('hex'))
  const directory=await mkdtemp(join(env.RUNNER_TEMP||tmpdir(),'mikka-api-receipt-'))
  try {
    const path=join(directory,'receipt.zip')
    await writeFile(path,archive,{mode:0o600,flag:'wx'})
    const files=execFileSync('unzip',['-Z1',path],{encoding:'utf8',maxBuffer:1024*1024}).trim().split('\n')
    assert.deepEqual(files,['api-image-receipt.json'])
    const receipt=JSON.parse(execFileSync('unzip',['-p',path,files[0]],{encoding:'utf8',maxBuffer:2*1024*1024}))
    checkedApiPublication(run,jobs,artifact,archive,receipt,env)
    await appendFile(env.GITHUB_ENV,'MIKKA_API_RECEIPT='+JSON.stringify(receipt)+'\nRUNTIME_SOURCE_SHA='+receipt.publicSha+'\n')
    assert.ok(env.GITHUB_OUTPUT)
    await appendFile(env.GITHUB_OUTPUT,'source='+receipt.publicSha+'\n')
    console.log('MIKKA_ORIGINAL_API_BUILD='+JSON.stringify({run:env.API_RUN_ID,attempt:env.API_RUN_ATTEMPT,artifact:String(artifact.id),source:receipt.publicSha,digest:receipt.digest}))
  } finally {await rm(directory,{recursive:true,force:true})}
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await load(process.env).catch(error=>{
  console.error('ORIGINAL_API_RECEIPT_FAILED',{name:error?.name??'Error'})
  process.exitCode=1
})

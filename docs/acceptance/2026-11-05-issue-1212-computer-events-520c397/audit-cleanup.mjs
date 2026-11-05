import assert from 'node:assert/strict'
import { readFile, writeFile, rm, lstat } from 'node:fs/promises'
const root='/vercel/sandbox/mikka-capture-c520-egress'
const output='/vercel/acceptance/capture-c520-egress'
process.chdir(root)
const run=JSON.parse(await readFile(output+'/runtime-manifest.json','utf8'))
assert.equal(run.sha,'520c397e2f58cdc69dd5c6d75f6e8d83ffe2b103')
assert.deepEqual(run.cleanup.databaseAbsent,true)
assert.deepEqual(run.cleanup.roleAbsent,true)
assert.deepEqual(run.cleanup.serverExited,true)
assert.deepEqual(run.cleanup.displayExited,true)
const descriptor='/vercel/acceptance/private-c520-environment/descriptor.json'
const environment=JSON.parse(await readFile(descriptor,'utf8'))
assert.equal(environment.deploymentSha,run.sha)
assert.equal(environment.origin,run.origin)
assert.equal(environment.database.name,run.database)
assert.equal(environment.database.user,run.role)
assert.match(environment.instanceId,/^[a-f0-9-]{36}$/)
const {auditEvidence}=await import(root+'/scripts/test-accounts/session.mjs')
const audit=await auditEvidence([output],{environment})
const receipt={audit,sha:run.sha,origin:run.origin,environmentId:environment.id,at:new Date().toISOString()}
await writeFile(output+'/full-evidence-audit.json',JSON.stringify(receipt,null,2)+'\n')
const privateState=root+'/.cache/e2e/test-accounts/'+environment.instanceId
assert.equal((await lstat(privateState)).isSymbolicLink(),false)
await rm(privateState,{recursive:true})
await rm('/vercel/acceptance/private-c520-environment',{recursive:true})
const exists=async p=>{try{await lstat(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
const cleanup={at:new Date().toISOString(),sha:run.sha,privateStateRemoved:!await exists(privateState),descriptorDirectoryRemoved:!await exists('/vercel/acceptance/private-c520-environment')}
await writeFile(output+'/private-cleanup.json',JSON.stringify(cleanup,null,2)+'\n')
console.log(JSON.stringify({audit,cleanup}))

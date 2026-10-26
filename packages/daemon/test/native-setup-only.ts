// Explicit create-and-pause entry. Never starts a container or calls disposal.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {createNativeRegistry,auditedNativeDocker} from './native-resource-registry.ts'

const image=process.argv[2]
assert.equal(process.argv.length,3,'one existing pinned image required')
assert.match(image,/^sha256:[a-f0-9]{64}$/)
assert.ok(!process.env.DOCKER_HOST&&!process.env.DOCKER_CONTEXT,'ambient endpoint forbidden')
const root=mkdtempSync(join(tmpdir(),'native-setup-only-')),config=join(root,'docker-config')
mkdirSync(config,{mode:0o700})
const registry=createNativeRegistry(join(root,'receipts'),config,{requests:1,configs:1})
const prefix=['--host','unix:///var/run/docker.sock','--config',config]
const execute=(args:string[])=>spawnSync('docker',args,{encoding:'utf8'})
const imageResult=execute([...prefix,'image','inspect',image])
assert.equal(imageResult.status,0,'existing image unavailable')
const imageInfo=JSON.parse(imageResult.stdout)[0]
assert.equal(imageInfo.Id,image)
assert.equal(Object.keys(imageInfo.Config.Volumes??{}).length,0,'implicit volumes forbidden')
registry.reserveConfigCreation()
const runtime=mkdtempSync(join(root,'mikka-group-docker-'))
registry.registerConfig(runtime)
const result=auditedNativeDocker(registry,[...prefix,'create','--name','mikka-group-cli-'+randomUUID(),'--pull=never','--network=none','--read-only','--entrypoint=/bin/true',image],execute)
assert.equal(result.status,0,'setup create unresolved; receipts retained')
const snapshot=registry.setupSnapshot(id=>{
 const inspected=execute([...prefix,'inspect','--type','container','--format','{{json .}}',id])
 assert.equal(inspected.status,0,'exact container readback unavailable')
 const value=JSON.parse(inspected.stdout)
 assert.deepEqual(value.Mounts,[],'unexpected mounts')
 return value
})
const receipt=join(root,'setup-receipt.json')
writeFileSync(receipt,JSON.stringify(snapshot,null,2),{mode:0o600,flag:'wx'})
console.log(JSON.stringify({receipt,...snapshot}))

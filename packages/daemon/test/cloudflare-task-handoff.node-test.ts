import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { receiveTaskHandoff } from '../src/cloudflare-task-handoff'
import { consumeCloudBootstrap } from '../src/cloud-bootstrap'

test('a Cloudflare task receives one standard device handoff over stdin and consumes private files', async () => {
  const temp = await mkdtemp(join(tmpdir(),'mikka-cloudflare-device-'))
  try {
    const root = join(temp,'state'), runId=randomUUID(), deviceId=randomUUID(), workspaceId=randomUUID()
    const bootstrap=JSON.stringify({deviceId,workspaceId,server:'https://example.invalid/mikka',credential:'orv_'+randomBytes(32).toString('base64url')})
    const input=()=>ReadableStream.from([Buffer.from(JSON.stringify({runId,bootstrap}))])
    await receiveTaskHandoff(root,input())
    assert.equal((await lstat(join(root,'bootstrap.json'))).mode & 0o777,0o600)
    await assert.rejects(()=>receiveTaskHandoff(root,input()), /EEXIST/)
    const config=consumeCloudBootstrap(join(root,'bootstrap.json'))
    assert.equal(config.initialRunId,runId)
    assert.equal(config.deviceId,deviceId)
    assert.equal(config.workspaceId,workspaceId)
    await assert.rejects(()=>lstat(join(root,'bootstrap.json')), /ENOENT/)
    await symlink(root,join(temp,'link'))
    await assert.rejects(()=>receiveTaskHandoff(join(temp,'link'),input()), /directory unavailable/)
    await assert.rejects(()=>receiveTaskHandoff(root,ReadableStream.from([Buffer.alloc(8193)])), /too large/)
  } finally {await rm(temp,{recursive:true,force:true})}
})

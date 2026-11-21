import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyEveImagePayload } from './verify-eve-image.mjs'

test('built Eve payload refuses corrupted resources and a different source or Workflow world', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-eve-image-payload-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const identity = { sourceSha: 'a'.repeat(40), releaseId: 'fixture-1' }
  const resource = 'immutable runtime resource\n'
  const manifest = { revision: identity.sourceSha, resources: [{ path: 'resource.txt', bytes: Buffer.byteLength(resource),
    sha256: createHash('sha256').update(resource).digest('hex') }] }
  await mkdir(join(directory, 'eve'))
  const host = { version: 1, ...identity, uiSha: identity.sourceSha, uiSource: 'public-server' }
  const agent = { version: 1, eve: '1.3.0', revision: identity.sourceSha, preset: 'node-server',
    world: '@workflow/world-postgres', worldVersion: '5.4.1' }
  await writeFile(join(directory, 'eve-host.json'), JSON.stringify(host))
  await writeFile(join(directory, 'eve/mikka-eve-build.json'), JSON.stringify(agent))
  await writeFile(join(directory, 'eve/resource.txt'), resource)
  await verifyEveImagePayload(directory, manifest, identity)
  await writeFile(join(directory, 'eve/resource.txt'), 'x'.repeat(Buffer.byteLength(resource)))
  await assert.rejects(verifyEveImagePayload(directory, manifest, identity), /API resource bytes differ/)
  await writeFile(join(directory, 'eve/resource.txt'), resource)
  await assert.rejects(verifyEveImagePayload(directory, manifest, { ...identity, sourceSha: 'b'.repeat(40) }))
  await writeFile(join(directory, 'eve/mikka-eve-build.json'), JSON.stringify({ ...agent, world: 'local' }))
  await assert.rejects(verifyEveImagePayload(directory, manifest, identity))
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { grant, verifyGatewayVersion } from './runtime'
import type { Sandbox } from 'e2b'

test('capability issuance rejects an old or unidentifiable running gateway', async () => {
  const py = await readFile('scripts/e2b/subagent-gateway.py')
  const launcher = await readFile('scripts/e2b/subagent-cdp.mjs')
  const version = createHash('sha256').update(py).update(launcher).digest('hex')
  let observed = version, keyReads = 0
  const sandbox = {
    commands: { run: async () => ({ stdout: observed }) },
    files: { read: async () => { keyReads++; return Buffer.alloc(32) } },
    getHost: () => 'sandbox.e2b.app',
  } as unknown as Sandbox
  await verifyGatewayVersion(sandbox)
  const binding = { id: 'task', ownerId: 'owner', workspaceId: 'workspace', botId: 'bot', epoch: 1 }
  observed = 'old-gateway-version'
  await assert.rejects(grant(sandbox, binding, 'broker'), /version mismatch/)
  assert.equal(keyReads, 0, 'do not mint a capability for an old process')
  observed = version
  assert.match((await grant(sandbox, binding, 'broker')).endpoint, /^https:\/\/sandbox\.e2b\.app\//)
  assert.equal(keyReads, 1)
})

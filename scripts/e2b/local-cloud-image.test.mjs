import assert from 'node:assert/strict'
import test from 'node:test'
import { Sandbox } from 'e2b'
import { bootstrapOfficialInstance } from '../../lib/computer/official-runtime.ts'
import { cloudAcceptanceRelease } from './cloud-acceptance-release.mjs'
import { startLoopbackCloudRelay } from './loopback-cloud-relay.mjs'
import { startLocalCloudImage } from './local-cloud-image.mjs'

// Explicit root-only integration entry, run in an owned network namespace.
// No skip/fallback exists: a missing kernel capability is a real failure.
test('fake E2B executes the actual compiled image and official preinstalled guard under root/user identities', async t => {
  const release = cloudAcceptanceRelease()
  const relay = await startLoopbackCloudRelay({ localOrigin: 'http://127.0.0.1:3100', repoToken: 'synthetic-local-repo-token'.padEnd(43, 'x') })
  t.after(() => relay.stop())
  const provider = await startLocalCloudImage({ release, ca: relay.ca })
  t.after(() => provider.close())
  const env = { MIKKA_CLOUD_WORKER_SOURCE_COMMIT: release.sourceCommit, MIKKA_CLOUD_WORKER_SHA: release.workerHash }
  for (const template of ['desktop', 'claude']) {
    const sandbox = await Sandbox.create(template, provider.e2bOptions)
    await bootstrapOfficialInstance(sandbox, template, env)
    assert.equal((await sandbox.commands.run('id -u', { user: 'root' })).stdout.trim(), '0')
    assert.equal((await sandbox.commands.run('id -u', { user: 'user' })).stdout.trim(), '1000')
    assert.match((await sandbox.commands.run('cat /proc/self/status', { user: 'user' })).stdout, /CapEff:\s+0+\n/)
    assert.equal((await sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim(), release.workerHash)
    assert.match((await sandbox.commands.run('/cli/claude --version', { user: 'user' })).stdout, /^\d+\.\d+\.\d+/)
    const capability = JSON.parse((await sandbox.commands.run('cat /opt/mikka/worker/packages/daemon/dist/cloud/runtime-capabilities.json', { user: 'root' })).stdout)
    assert.deepEqual(capability, { registrationNoticeVersion: 1, workerSha: release.workerHash })
    await assert.rejects(sandbox.commands.run('cat /run/mikka-workspace-ingress/receipt.json', { user: 'user' }))
  }
})

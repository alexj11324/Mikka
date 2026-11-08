import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import type { Sandbox } from 'e2b'
import type { TaskReviewAuthority } from '../review-authority'

mock.module('../../computer/e2b-provider', { namedExports: {
  connectComputer: async () => { throw new Error('Unexpected real provider call') },
  computerState: async () => 'running',
  computerGone: (error: unknown) => error instanceof Error && error.name === 'SandboxNotFoundError',
} })
mock.module('../../auth-config', { namedExports: { authTrustedOrigins: () => ['https://mikka.example.test'] } })
const { prepareRunPreview, issueRunPreview, revokeRunPreview, previewParentOrigin, PreviewRuntimeError } = await import('./runtime')

const authority = {
  taskId: 'task-synthetic', runId: 'run-synthetic', ownerId: 'owner-synthetic', workspaceId: 'workspace-synthetic',
  deviceId: 'device-synthetic', repoId: 'repo-synthetic', sandboxId: 'sandbox-synthetic',
  machineEpoch: 1, worktreePath: '/workspace/project', machineKind: 'cloud', credentialExpiresAt: null,
} as TaskReviewAuthority
const ingress = { ok: true, version: 1, sourceSha256: 'a'.repeat(64), bootId: '1'.repeat(36),
  installedTicks: 1, providerPorts: [49983], preparedBeforeWorker: true, rulesVerified: { ipv4: true, ipv6: true } }

async function fixture() {
  const version = createHash('sha256').update(await readFile('scripts/e2b/preview-gateway.py')).update(await readFile('scripts/e2b/preview_firewall.py')).digest('hex')
  const files = new Map<string, string>()
  const commands: string[] = []
  const messages: Record<string, unknown>[] = []
  const state = { version, available: true, present: true, revoked: true, ticket: 'a'.repeat(43), expiresAt: 0, ingress: JSON.stringify(ingress) }
  const sandbox = {
    sandboxId: 'sandbox-synthetic',
    getHost: (port: number) => `${port}-sandbox-synthetic.e2b.app`,
    files: { write: async (path: string, data: string) => { files.set(path, data) } },
    commands: { run: async (command: string) => {
      commands.push(command)
      if (command.includes('ingress-v1/guard.py verify')) return { stdout: state.ingress }
      if (command.endsWith(' ensure')) return { stdout: JSON.stringify({ version: state.version }) }
      if (command.startsWith('if test -S')) return { stdout: state.present ? 'present' : 'absent' }
      if (command.includes(' control ')) {
        const path = command.split(' ').at(-1)!
        const message = JSON.parse(files.get(path)!) as Record<string, unknown>
        messages.push(message)
        if (message.operation === 'prepare') {
          const binding = message.binding as { expiresAt: number }
          state.expiresAt = binding.expiresAt
          return { stdout: JSON.stringify(state.available ? { running: true, gatewayPort: 46123, port: 3000, expiresAt: binding.expiresAt, version } : { running: false, code: 'no_loopback_server' }) }
        }
        if (message.operation === 'issue') {
          const binding = message.binding as { expiresAt: number }
          return { stdout: JSON.stringify({ ticket: state.ticket, expiresAt: binding.expiresAt }) }
        }
        if (message.operation === 'revoke') return { stdout: JSON.stringify({ revoked: state.revoked }) }
      }
      return { stdout: '' }
    } },
  } as unknown as Sandbox
  return { state, sandbox, commands, messages, files, connect: async () => sandbox }
}

test('preview preserves the frontend running discriminant and isolated one-use entry contract', async () => {
  const f = await fixture()
  const prepared = await prepareRunPreview(authority, {}, f.connect)
  assert.equal(prepared.running, true)
  if (!prepared.running) throw new Error('Expected a prepared preview')
  const expiry = new Date(Date.now() + 30_000).toISOString()
  const result = await issueRunPreview(prepared, 'https://mikka.example.test', { id: 'lease-synthetic', expiresAt: expiry })
  assert.equal(result.running, true)
  const url = new URL(result.url)
  assert.equal(url.origin, 'https://46123-sandbox-synthetic.e2b.app')
  assert.equal(url.pathname, '/__mikka/preview/open')
  assert.deepEqual([...url.searchParams.keys()], ['ticket'])
  assert.equal(result.expiresAt, expiry)
  assert.equal(f.messages[0].operation, 'prepare')
  assert.equal(f.messages[1].operation, 'issue')
  assert.match(f.commands[0], /ingress-v1\/guard\.py verify/)
  assert.ok(!f.commands.some(command => /guard\.py (prepare|ready)/.test(command)))
  for (const command of f.commands) {
    assert.ok(!command.includes('owner-synthetic'))
    assert.ok(!command.includes('run-synthetic'))
    assert.ok(!command.includes(f.state.ticket))
  }
})

test('old, altered or unproved VM ingress is 404 before any gateway write or capability', async () => {
  for (const value of ['{"ok":false}', '', 'null', '[]', 'x'.repeat(4097),
    JSON.stringify({ ...ingress, preparedBeforeWorker: false }),
    JSON.stringify({ ...ingress, rulesVerified: { ipv4: true, ipv6: false } }),
    JSON.stringify({ ...ingress, providerPorts: [50005] }),
    JSON.stringify({ ...ingress, installedTicks: -1 }),
    JSON.stringify({ ...ingress, sourceSha256: 'stale' }),
  ]) {
    const f = await fixture()
    f.state.ingress = value
    await assert.rejects(prepareRunPreview(authority, {}, f.connect), (error: unknown) => error instanceof PreviewRuntimeError
      && error.detail === 'configuration' && error.status === 404)
    assert.equal(f.files.size, 0)
    assert.equal(f.messages.length, 0)
    assert.equal(f.commands.length, 1)
  }
})

test('no server is a normal unavailable result; version mismatch never issues a ticket', async () => {
  const f = await fixture()
  f.state.available = false
  assert.equal((await prepareRunPreview(authority, {}, f.connect)).running, false)
  f.state.version = 'stale-running-gateway'
  await assert.rejects(prepareRunPreview(authority, {}, f.connect), (error: unknown) => error instanceof PreviewRuntimeError && error.detail === 'configuration')
  assert.deepEqual(f.messages.map(message => message.operation), ['prepare'])
})

test('local machines, invalid ports, expired credentials and malformed tickets fail closed', async () => {
  const f = await fixture()
  for (const [scope, options] of [
    [{ ...authority, machineKind: 'local' as const }, {}],
    [authority, { port: 0 }],
    [{ ...authority, credentialExpiresAt: new Date(0).toISOString() }, {}],
  ] as const) await assert.rejects(prepareRunPreview(scope, options, f.connect), PreviewRuntimeError)
  assert.equal(f.commands.length, 0)
  const prepared = await prepareRunPreview(authority, {}, f.connect)
  if (!prepared.running) throw new Error('Expected a prepared preview')
  f.state.ticket = 'untrusted/entry?scope=other'
  await assert.rejects(issueRunPreview(prepared, 'https://mikka.example.test', { id: 'lease-synthetic', expiresAt: prepared.expiresAt }), (error: unknown) => error instanceof PreviewRuntimeError && error.detail === 'protocol')
  await assert.rejects(issueRunPreview(prepared, 'https://46123-sandbox-synthetic.e2b.app', { id: 'lease-synthetic', expiresAt: prepared.expiresAt }), PreviewRuntimeError)
  await assert.rejects(issueRunPreview(prepared, 'https://mikka.example.test', { id: 'lease-synthetic', expiresAt: new Date(Date.now() + 600_000).toISOString() }), PreviewRuntimeError)
})

test('revoke requires the gateway acknowledgement and propagates provider failures with cause', async () => {
  const f = await fixture()
  const target = { runId: authority.runId, ownerId: authority.ownerId, workspaceId: authority.workspaceId, sandboxId: authority.sandboxId! }
  await revokeRunPreview(target, {}, f.connect)
  assert.deepEqual(f.messages, [{ operation: 'revoke', runId: authority.runId }])
  f.state.revoked = false
  await assert.rejects(revokeRunPreview(target, {}, f.connect), PreviewRuntimeError)
  const cause = new Error('Synthetic provider failure')
  await assert.rejects(revokeRunPreview(target, {}, async () => { throw cause }), (error: unknown) => error instanceof PreviewRuntimeError && error.cause === cause)
  const gone = Object.assign(new Error('Synthetic missing sandbox'), { name: 'SandboxNotFoundError' })
  await revokeRunPreview(target, {}, async () => { throw gone })
})

test('parent origin uses the exact configured allowlist, never an arbitrary Host or Origin', () => {
  assert.equal(previewParentOrigin(new Request('https://mikka.example.test/api/tasks/task/review/preview')), 'https://mikka.example.test')
  for (const request of [new Request('https://attacker.invalid/api/tasks/task/review/preview'),
    new Request('https://mikka.example.test/api/tasks/task/review/preview', { headers: { origin: 'https://attacker.invalid' } })])
    assert.throws(() => previewParentOrigin(request), (error: unknown) => error instanceof PreviewRuntimeError && error.status === 403)
})

test('revocation never resumes a paused VM; only proved expired frozen leases can acknowledge', async () => {
  const f = await fixture()
  const target = { runId: authority.runId, ownerId: authority.ownerId, workspaceId: authority.workspaceId, sandboxId: authority.sandboxId! }
  let connected = false
  const connect = async () => { connected = true; return f.sandbox }
  const paused = async () => 'sleeping' as const
  await assert.rejects(revokeRunPreview(target, { leaseIds: ['lease-synthetic'] }, connect, paused), PreviewRuntimeError)
  await revokeRunPreview(target, { leaseIds: ['lease-synthetic'], expiresAt: new Date(0).toISOString() }, connect, paused)
  assert.equal(connected, false)
  await assert.rejects(prepareRunPreview(authority, {}, connect, paused), PreviewRuntimeError)
  assert.equal(connected, false)
})

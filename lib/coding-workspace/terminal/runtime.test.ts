import assert from 'node:assert/strict'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, mock, test } from 'node:test'
import { TerminalError } from '@mikka/protocol/coding-terminal'
import { terminalKey } from './wire'
import { terminalFixture } from './test-fixture'

class MissingSandbox extends Error {}
const state = { machine: 'running', present: true, validProof: true, version: '', boot: randomUUID(),
  connects: 0, reads: 0, missing: false, status: 204, ingress: '', commands: [] as string[], writes: [] as { path: string; data: string | ArrayBuffer }[] }
class SyntheticSandbox {
  constructor(_options: unknown) {}
  static async getInfo() { state.reads++; if (state.missing) throw new MissingSandbox(); return { state: state.machine, envdVersion: 'synthetic', sandboxDomain: 'e2b.app' } }
  static async connect() { state.connects++; return new SyntheticSandbox({}) }
  getHost(port: number) { return `${port}-sandbox-synthetic.e2b.app` }
  commands = { run: async (command: string) => {
    state.commands.push(command)
    if (command.startsWith('if test -f ')) return { exitCode: 0, stdout: state.ingress }
    if (command.startsWith('python3 -I -c ')) state.present = true
    return { exitCode: 0, stdout: '' }
  } }
  files = { write: async (files: { path: string; data: string | ArrayBuffer }[]) => { state.writes.push(...files) } }
}
mock.module('e2b', { namedExports: { Sandbox: SyntheticSandbox, SandboxNotFoundError: MissingSandbox } })
mock.module('../../secrets/e2b-runtime', { namedExports: {
  e2bApiKey: async () => 'provider-fixture-never-used-on-network',
  withE2BErrors: async (_owner: string, _creating: boolean, run: () => Promise<unknown>) => run(),
} })
const { prepareTerminal, existingTerminal, terminalRequest, revokeRunTerminal } = await import('./runtime')
const originalFetch = globalThis.fetch, originalSecret = process.env.BETTER_AUTH_SECRET
afterEach(() => { globalThis.fetch = originalFetch; if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET; else process.env.BETTER_AUTH_SECRET = originalSecret })

async function fixture() {
  const f = terminalFixture(), calls: string[] = []
  Object.assign(state, { machine: 'running', present: true, validProof: true, boot: randomUUID(), connects: 0, reads: 0, missing: false, status: 204, commands: [], writes: [] })
  state.version = createHash('sha256').update(await readFile('scripts/e2b/terminal-gateway.py')).digest('hex')
  state.ingress = JSON.stringify({ ok: true, version: 1, sourceSha256: 'a'.repeat(64), bootId: randomUUID(),
    installedTicks: 1, providerPorts: [49983], preparedBeforeWorker: true, rulesVerified: { ipv4: true, ipv6: true } })
  process.env.BETTER_AUTH_SECRET = 'synthetic-control-plane-fixture-'.repeat(2)
  const target = { runId: f.scope.runId, ownerId: f.scope.ownerId, workspaceId: f.scope.workspaceId, sandboxId: f.scope.sandboxId! }
  const key = terminalKey(target, process.env.BETTER_AUTH_SECRET)
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); calls.push(url.pathname)
    if (url.pathname === '/health') {
      if (!state.present) return new Response(null, { status: 503 })
      const challenge = url.searchParams.get('challenge')
      const proof = createHmac('sha256', key).update(`health:v1:${challenge}:${state.boot}:${state.version}`).digest('hex')
      return Response.json({ boot: state.boot, version: state.version, proof: state.validProof ? proof : '0'.repeat(64) })
    }
    assert.equal(options?.redirect, 'error')
    assert.equal(options?.cache, 'no-store')
    if (state.status !== 204) return Response.json({ error: 'untrusted-upstream-text' }, { status: state.status })
    return new Response(null, { status: 204 })
  }
  return { ...f, target, key, calls }
}

test('existing terminal only reads provider identity and authenticates root health without resuming a VM', async () => {
  const f = await fixture(), prepared = await existingTerminal(f.scope)
  assert.equal(prepared.boot, state.boot)
  assert.equal(prepared.bindingId, f.scope.bindingId)
  assert.equal(state.connects, 0)
  assert.equal(state.writes.length, 0)
  assert.equal(state.commands.length, 0, 'input lookup never performs a remote ingress command')
  assert.deepEqual(f.calls, ['/health'])
})

test('opening even an existing gateway requires the pre-worker dual-stack ingress guard', async () => {
  for (const present of [false, true]) for (const receipt of ['', 'supported', '{"ok":false}',
    JSON.stringify({ ok: true, version: 1, preparedBeforeWorker: false, rulesVerified: { ipv4: true, ipv6: true } }),
    JSON.stringify({ ok: true, version: 1, preparedBeforeWorker: true, rulesVerified: { ipv4: true, ipv6: false } })]) {
    const f = await fixture(); state.present = present; state.ingress = receipt
    await assert.rejects(prepareTerminal(f.scope), (error: unknown) => error instanceof TerminalError
      && error.code === 'terminal_unsupported' && error.status === 404 && error.detail === 'runtime_version')
    assert.equal(state.writes.length, 0, 'old/staged VMs are never repaired while opening review')
    assert.equal(state.commands.length, 1)
    assert.match(state.commands[0]!, /\/ingress-v1\/guard\.py verify/)
    assert.doesNotMatch(state.commands[0]!, /\/ingress-v1\/guard\.py (?:prepare|install)/)
  }
  const f = await fixture()
  const prepared = await prepareTerminal(f.scope)
  assert.equal(prepared.boot, state.boot)
  assert.equal(state.commands.length, 1, 'control and ingress use the same read-only opening preflight')
  assert.equal(state.writes.length, 0)
})

test('initial preparation installs one immutable root gateway using a derived key, never a new VM or Agent', async () => {
  const f = await fixture(); state.present = false
  const prepared = await prepareTerminal(f.scope)
  assert.equal(prepared.boot, state.boot)
  assert.equal(state.connects, 1)
  assert.equal(state.writes.length, 2)
  assert.match(state.writes[0]!.path, /gateway-[a-f0-9]{64}\.py$/)
  assert.equal(state.writes[1]!.path, '/run/mikka-terminal/key')
  assert.ok(state.writes[1]!.data instanceof ArrayBuffer)
  assert.equal((state.writes[1]!.data as ArrayBuffer).byteLength, 32)
  for (const command of state.commands) {
    assert.equal(command.includes(process.env.BETTER_AUTH_SECRET!), false)
    assert.equal(command.includes('provider-fixture'), false)
    assert.equal(command.includes(f.scope.worktreePath), false)
  }
  assert.deepEqual(f.calls, ['/health', '/health'])
})

test('a forged health/version receipt cannot authorize a user-owned listener', async () => {
  const f = await fixture(); state.validProof = false
  await assert.rejects(existingTerminal(f.scope), (error: unknown) => error instanceof TerminalError && error.code === 'terminal_ended')
  await assert.rejects(prepareTerminal(f.scope), (error: unknown) => error instanceof TerminalError && error.code === 'terminal_unsupported')
  assert.equal(state.connects, 1)
})

test('local devices, active Agents, destroyed machines and old gateway versions fail closed', async () => {
  const f = await fixture()
  await assert.rejects(prepareTerminal({ ...f.scope, machineKind: 'local' }), (error: unknown) => error instanceof TerminalError && error.status === 404)
  await assert.rejects(prepareTerminal({ ...f.scope, nativeExitedProof: false }), (error: unknown) => error instanceof TerminalError && error.status === 423)
  assert.equal(state.reads, 0)
  state.missing = true
  await assert.rejects(existingTerminal(f.scope), (error: unknown) => error instanceof TerminalError && error.status === 409)
  state.missing = false; state.version = 'a'.repeat(64)
  await assert.rejects(prepareTerminal(f.scope), (error: unknown) => error instanceof TerminalError && error.status === 404)
  assert.equal(state.connects, 0)
})

test('revocation never wakes a paused VM and only acknowledges a proven expired or destroyed machine', async () => {
  const f = await fixture(); state.machine = 'paused'
  await assert.rejects(revokeRunTerminal(f.target, { leaseIds: [f.lease.id] }), TerminalError)
  await assert.rejects(revokeRunTerminal(f.target, { leaseIds: [f.lease.id], expiresAt: 'invalid' }), TerminalError)
  await revokeRunTerminal(f.target, { leaseIds: [f.lease.id], expiresAt: new Date(0).toISOString() })
  assert.equal(state.connects, 0)
  assert.deepEqual(f.calls, [])
  state.missing = true
  await revokeRunTerminal(f.target, { leaseIds: [f.lease.id] })
})

test('running revocation requires a signed gateway receipt and an actual close acknowledgement', async () => {
  const f = await fixture()
  await revokeRunTerminal(f.target, { leaseIds: [f.lease.id] })
  assert.deepEqual(f.calls, ['/health', '/revoke'])
  state.present = false
  await assert.rejects(revokeRunTerminal(f.target, { leaseIds: [f.lease.id] }), TerminalError)
  state.present = true; state.status = 503
  await assert.rejects(revokeRunTerminal(f.target, { leaseIds: [f.lease.id] }), TerminalError)
  assert.equal(state.connects, 0)
})

test('data plane refuses an invalid response protocol without leaking remote text', async () => {
  const f = await fixture()
  state.status = 500
  await assert.rejects(terminalRequest(f.prepared, 'input', 'synthetic-ticket', '{}'), (error: unknown) =>
    error instanceof TerminalError && error.code === 'terminal_unavailable' && error.detail === 'protocol')
  state.status = 204
  await assert.rejects(terminalRequest(f.prepared, 'stream', 'synthetic-ticket'), (error: unknown) =>
    error instanceof TerminalError && error.detail === 'protocol')
})

import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { RunAssignment } from '@mikka/protocol'
import { mailboxInputs } from '@mikka/protocol/mailbox'
import { assertMailboxRunAuthority, createRunMailbox, mailboxToolResult } from '../src/run-mailbox'
import { ClaudeAdapter } from '../src/adapters/claude'
import { CodexAdapter } from '../src/adapters/codex'
import { NoSandbox } from '../src/agents/sandbox'
import { createLogger } from '../src/log'
import { buildChildEnv } from '../src/env'
import { HttpServerLink } from '../src/server-link-http'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import type { JournalEntry } from '../src/runs/journal'
import type { StartOptions, AgentSession } from '../src/adapters/types'
import { getEventListeners } from 'node:events'
import { execFileSync } from 'node:child_process'

// Synthetic process fixtures and retained local Git worktrees only.
// No database, Docker, login or network fetch.
// All files/empty IPC directories are retained; no cleanupTempDirs/rm/prune.
const retained = mkdtempSync(join(tmpdir(), 'mikka-mailbox-cli-'))
const supervisorRepository = join(retained, 'supervisor-repository')
const supervisorWorktree = join(retained, 'supervisor-worktree')
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
function fixtureGit(args: string[]) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { env: gitEnv, stdio: 'pipe' })
}
mkdirSync(supervisorRepository)
fixtureGit(['init', '-q', supervisorRepository])
fixtureGit(['-C', supervisorRepository, '-c', 'user.name=Mailbox fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Synthetic mailbox fixture'])
fixtureGit(['-C', supervisorRepository, 'worktree', 'add', '--detach', supervisorWorktree, 'HEAD'])
const endpoint = new URL('https://mikka.invalid/mikka/api/mcp')
function fixture() {
  const token = 'mkw_' + randomBytes(32).toString('base64url')
  const assignment = { runId: randomUUID(), mcp: { url: endpoint.href, token, mailbox: true } } as RunAssignment
  const abort = new AbortController()
  const state = { revoked: false, cancelled: false, dropped: false, oversized: false, malformed: false, disabled: false, revokeOnSent: false, requests: 0, writes: 0, headersValid: true, allowed: Object.keys(mailboxInputs) }
  const keys = new Map<string, string>()
  const transport: typeof fetch = async (url, init) => {
    state.requests++
    assert.equal(String(url), endpoint.href)
    assert.equal(init?.redirect, 'error')
    state.headersValid &&= new Headers(init?.headers).get('authorization') === 'Bearer ' + token
    if (state.revoked) return new Response('Unauthorized', { status: 401 })
    const packet = JSON.parse(String(init?.body))
    let result: unknown
    if (packet.method === 'initialize') result = { protocolVersion: '2025-03-26' }
    else if (packet.method === 'notifications/initialized') return new Response(null, { status: 202 })
    else if (packet.method === 'tools/list') result = { tools: state.disabled ? [] : [...state.allowed, 'dangerous_admin'].map(name => ({ name })) }
    else {
      const { name, arguments: args } = packet.params
      if (name === 'mailbox_send') {
        if (args.to === '00000000-0000-4000-8000-000000000099') return Response.json({ jsonrpc: '2.0', id: packet.id, result: { isError: true, content: [{ type: 'text', text: 'Recipient unavailable' }] } })
        if (!keys.has(args.key)) { keys.set(args.key, randomUUID()); state.writes++ }
        if (state.dropped) { state.dropped = false; throw new Error('Synthetic lost acknowledgement') }
        result = { content: [{ type: 'text', text: JSON.stringify({ id: keys.get(args.key), queued: true }) }] }
      } else { result = { content: [{ type: 'text', text: name === 'mailbox_recipients' ? '{"self":"host-owned-address"}' : '[]' }] }; if (name === 'mailbox_sent' && state.revokeOnSent) state.revoked = true }
    }
    if (state.oversized) return new Response('x'.repeat(1048577), { headers: { 'content-type': 'application/json' } })
    if (state.malformed) return new Response('not JSON', { headers: { 'content-type': 'application/json' } })
    return Response.json({ jsonrpc: '2.0', id: packet.id, result })
  }
  const create = () => createRunMailbox({ assignment, endpoint, fetch: transport, signal: abort.signal, check: () => { if (state.cancelled) throw new Error('Stopped') } })
  return { token, assignment, abort, state, create, transport }
}

test('claim parser preserves only an explicit transport capability and uses the configured MCP endpoint', async () => {
  const f = fixture(), assignment: RunAssignment = { ...f.assignment, issueId: 'issue', deviceId: 'device', repoId: 'repo', baseBranch: 'main', harness: 'codex', prompt: 'Peer coordination' }
  let enabled = true
  const link = new HttpServerLink('https://mikka.invalid/mikka', async (url, init) => String(url).endsWith('/claim')
    ? Response.json({ ...assignment, mcp: { url: endpoint.href, token: f.token, ...(enabled ? { mailbox: true } : {}) } })
    : f.transport(url, init))
  const claimed = await link.claimRun('device', assignment.runId)
  assert.equal(claimed.mcp?.mailbox, true)
  await (await link.prepareRunMailbox(claimed, f.abort.signal, () => {}))!.close()
  enabled = false
  const before = f.state.requests
  assert.equal(await link.prepareRunMailbox(await link.claimRun('device', assignment.runId), f.abort.signal, () => {}), undefined)
  assert.equal(f.state.requests, before)
})

function supervisorFixture(f: ReturnType<typeof fixture>, failingClose = false, controls: { pause?: { entered(): void; wait: Promise<void> }; noLease?: boolean } = {}) {
  const entries = new Map<string, JournalEntry>(), records: { kind: string }[] = []
  const state = { starts: 0, closes: 0 }
  let opened!: (value: StartOptions) => void, entered!: () => void, finish!: () => void
  const options = new Promise<StartOptions>(resolve => { opened = resolve }), running = new Promise<void>(resolve => { entered = resolve }), ending = new Promise<void>(resolve => { finish = resolve })
  const journal = {
    get: (id: string) => entries.get(id), all: () => [...entries.values()], active: () => [...entries.values()],
    put: (entry: JournalEntry) => { entries.set(entry.assignment.runId, entry) },
    update: (id: string, patch: Partial<JournalEntry>) => { const entry = { ...entries.get(id)!, ...patch }; entries.set(id, entry); return entry },
  }
  const adapter = { harness: 'mock' as const, capabilities: { supportsInterject: false, supportsResume: false }, envAllow: [], async start(value: StartOptions): Promise<AgentSession> {
    state.starts++
    opened(value)
    return { sessionId: 'synthetic', async *events() { entered(); await ending; yield { type: 'exit' as const, outcome: 'cancelled' as const } }, async send() {}, async cancel() { finish() } }
  }, async resume(): Promise<AgentSession> { throw Error('Unexpected resume') } }
  const repo = { repoId: 'repo', name: 'synthetic', path: supervisorRepository }
  const repositoryDeps = {
    repository(assignment: RunAssignment) { assert.equal(assignment.repoId, repo.repoId); return repo },
    async prepareRepository() {},
  } satisfies Pick<SupervisorDeps, 'repository' | 'prepareRepository'>
  const supervisor = new RunSupervisor({ journal, outbox: { push(_id: string, record: { kind: string }) { records.push(record) }, async compact() {}, lastChunkSeq() { return 0 } },
    worktrees: { pathFor: () => supervisorWorktree, async changedFiles() { return [] } }, adapters: new Map([['mock', adapter]]), ...repositoryDeps, log: createLogger({ level: 'silent' }),
    prepareRunMailbox: async (assignment: RunAssignment, signal: AbortSignal, check: () => void) => {
      const mailbox = await createRunMailbox({ assignment, endpoint, signal, check, fetch: f.transport })
      if (controls.pause) { controls.pause.entered(); await controls.pause.wait }
      return mailbox ? { ...mailbox, async close() { state.closes++; await mailbox.close(); if (failingClose) throw Error('Synthetic close failure') } } : undefined
    }, cancelGraceMs: 10,
  } as unknown as SupervisorDeps)
  const assignment = { ...f.assignment, repoId: 'repo', harness: 'mock', prompt: 'Synthetic', ...(controls.noLease ? {} : { leaseExpiresAt: new Date(Date.now() + 60000).toISOString() }) } as RunAssignment
  journal.put({ assignment, state: 'queued', sessionId: null, worktree: supervisorWorktree, baseCommit: 'synthetic', lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
  supervisor.resumeAll()
  return { supervisor, records, get options() { return Promise.race([options, supervisor.idle().then(() => { throw Error('Supervisor ended before starting the fixture adapter: ' + supervisor.list().map(run => run.error).join('; ')) })]) }, running, finish, state }
}

for (const mode of ['stop', 'lease-expiry', 'default-off', 'close-failure']) test(`actual Supervisor wires the callback and clears custody after ${mode}`, { timeout: 10_000 }, async () => {
  const f = fixture(); if (mode === 'default-off') delete f.assignment.mcp!.mailbox
  const h = supervisorFixture(f, mode === 'close-failure', { noLease: mode === 'default-off' })
  const options = await h.options; await h.running
  if (mode === 'default-off') { assert.equal(options.mailbox, undefined); assert.equal(f.state.requests, 0) }
  else assert.ok(options.mailbox)
  if (mode === 'lease-expiry') { h.supervisor.check(Date.now() + 120000); await h.supervisor.idle() }
  else if (mode === 'close-failure') { h.finish(); await h.supervisor.idle() }
  else await h.supervisor.cancel(f.assignment.runId)
  assert.deepEqual(h.supervisor.activeRunIds(), [])
  assert.equal(h.records.filter(record => record.kind === 'complete').length, 1)
  assert.equal(h.state.closes, mode === 'default-off' ? 0 : 1)
  if (options.mailbox) {
    const before = f.state.requests
    assert.equal((await options.mailbox.request({ operation: 'list' }) as { isError: boolean }).isError, true)
    assert.equal(f.state.requests, before)
  }
})

for (const mode of ['stop', 'lease-expiry', 'shutdown']) test(`Supervisor handshake handoff ${mode} closes once without starting a CLI`, { timeout: 10_000 }, async () => {
  const f = fixture(); let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), wait = new Promise<void>(resolve => { release = resolve })
  const h = supervisorFixture(f, false, { pause: { entered, wait } })
  await ready
  const ending = mode === 'stop' ? h.supervisor.cancel(f.assignment.runId) : mode === 'shutdown' ? h.supervisor.stop() : undefined
  if (mode === 'lease-expiry') h.supervisor.check(Date.now() + 120000)
  release(); await ending; await h.supervisor.idle()
  assert.equal(h.state.starts, 0); assert.equal(h.state.closes, 1)
  assert.deepEqual(h.supervisor.activeRunIds(), [])
  assert.equal(h.records.filter(record => record.kind === 'complete').length, mode === 'shutdown' ? 0 : 1)
})

test('explicit mailbox close removes its run abort listener without retaining authority', async () => {
  const f = fixture(), mailbox = (await f.create())!
  assert.equal(getEventListeners(f.abort.signal, 'abort').length, 1)
  await mailbox.close(); await mailbox.close()
  assert.equal(getEventListeners(f.abort.signal, 'abort').length, 0)
})

test('capability defaults off and arbitrary host/path/credentials never receive a request', async () => {
  const f = fixture(); delete f.assignment.mcp!.mailbox
  assert.equal(await f.create(), undefined); assert.equal(f.state.requests, 0)
  f.assignment.mcp!.mailbox = true
  for (const url of ['https://evil.invalid/mikka/api/mcp', 'https://mikka.invalid/other', 'https://u:p@mikka.invalid/mikka/api/mcp', endpoint.href + '?redirect=evil', 'http://mikka.invalid/mikka/api/mcp']) {
    f.assignment.mcp!.url = url
    await assert.rejects(f.create(), /Run mailbox unavailable/)
  }
  assert.equal(f.state.requests, 0)
  f.assignment.mcp!.url = endpoint.href; f.state.disabled = true
  assert.equal(await f.create(), undefined)
})

test('Supervisor admission requires held nonterminal run and a present fresh lease, including the terminal-before-close window', () => {
  const live = { held: true, state: 'running' as const, stopped: false, lease: Date.now() + 60000 }
  assert.doesNotThrow(() => assertMailboxRunAuthority(live))
  for (const change of [{ held: false }, { state: 'failed' as const }, { stopped: true }, { lease: undefined }, { lease: NaN }, { lease: Date.now() - 1 }]) assert.throws(() => assertMailboxRunAuthority({ ...live, ...change }), /Run mailbox unavailable/)
})

test('actual configured HTTP link pins the optional host adapter to its own Mikka endpoint', async () => {
  const f = fixture(), link = new HttpServerLink('https://mikka.invalid/mikka', f.transport)
  const mailbox = await link.prepareRunMailbox(f.assignment, f.abort.signal, () => {})
  assert.ok(mailbox)
  await mailbox.close()
  f.assignment.mcp!.url = 'https://other-owner.invalid/mikka/api/mcp'
  const before = f.state.requests
  await assert.rejects(link.prepareRunMailbox(f.assignment, f.abort.signal, () => {}), /Run mailbox unavailable/)
  assert.equal(f.state.requests, before)
})

for (const kind of ['claude_code', 'codex'] as const) test(`${kind} actual fake CLI consumes the run-bound MCP config, strict schemas and shared peer transport`, async () => {
  const f = fixture(), mailbox = (await f.create())!
  f.state.revokeOnSent = true
  const stateDir = join(retained, kind, 'state'), home = join(retained, kind, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const log = createLogger({ level: 'silent' })
  const adapter = kind === 'codex'
    ? new CodexAdapter({ sandbox: new NoSandbox(), stateDir, binary: resolve('test/fakes/fake-codex.mjs'), userHome: home })
    : new ClaudeAdapter({ stateDir, binary: resolve('test/fakes/fake-claude.mjs'), configDir: join(home, '.claude') })
  const args = { to: '00000000-0000-4000-8000-000000000001', key: randomUUID(), text: 'normal peer work' }
  const calls = [
    { name: '__mailbox_catalog' }, { name: 'mailbox_recipients', foreignNotice: true },
    { name: 'mailbox_send', arguments: args }, { name: 'mailbox_send', arguments: args },
    { name: 'mailbox_send', arguments: { ...args, origin: 'owner', userId: 'victim', url: 'https://evil.invalid' } },
    { name: 'mailbox_send', arguments: { ...args, to: '00000000-0000-4000-8000-000000000099' } },
    { name: 'mailbox_send', arguments: { ...args, key: randomUUID() }, foreignContext: true },
    { name: 'mailbox_sent' }, { name: 'mailbox_inbox' },
    { name: 'mailbox_send', arguments: { ...args, key: randomUUID() } },
  ]
  try {
    const session = await adapter.start({ runId: f.assignment.runId, cwd: resolve('../..'), env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }), log, mailbox, prompt: 'MAILBOX_TEST ' + JSON.stringify(calls) })
    const chunks = []
    for await (const event of session.events()) chunks.push(event)
    const text = chunks.flatMap(event => event.type === 'chunk' && event.chunk.type === 'text-delta' ? [event.chunk.delta] : []).join('')
    assert.equal(text.includes(f.token), false, 'Platform bearer must not enter child output/config')
    const output = JSON.parse(text)
    assert.equal(output.hostControlMailbox, true)
    assert.ok(!JSON.stringify(output.mcpConfig).includes('--mailbox-socket'))
    const results = output.mailboxResults.map((r: { result: unknown }) => r.result) as Array<{ tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] }>
    const names = results[0].tools!.map(tool => tool.name)
    for (const name of Object.keys(mailboxInputs)) assert.ok(names.includes(name))
    assert.ok(!names.includes('dangerous_admin'))
    assert.equal(results[2].content![0].text, results[3].content![0].text)
    assert.equal(results[4].isError, true); assert.equal(results[5].isError, true)
    assert.ok(output.mailboxResults[6].error || results[6]?.isError)
    assert.equal(results[8].isError, true); assert.equal(results[9].isError, true)
    assert.equal(f.state.writes, 1); assert.equal(f.state.headersValid, true)
    writeFileSync(join(retained, kind, 'result.json'), JSON.stringify({ fakeCLI: true, providerCalls: 0, sourceActor: 'host-run', schemasReceived: names, writes: 1, sourceSpoofRejected: true, crossOwnerFixtureRejected: true, bearerInOutput: false }))
  } finally { await mailbox.close() }
})

test('cancel, revoked bearer and malformed/oversized responses fail closed; uncertain send uses original key without auto-replay', async () => {
  assert.equal(mailboxToolResult({ isError: 'true', content: [{ type: 'text', text: 'not success' }] }).isError, true)
  const f = fixture(), mailbox = (await f.create())!, args = { to: '00000000-0000-4000-8000-000000000001', key: randomUUID(), text: 'stable message' }
  try {
    f.state.dropped = true
    assert.equal((await mailbox.request({ operation: 'call', name: 'mailbox_send', arguments: args }) as { isError: boolean }).isError, true)
    assert.equal(f.state.writes, 1)
    await mailbox.request({ operation: 'call', name: 'mailbox_send', arguments: args }); assert.equal(f.state.writes, 1)
    f.state.oversized = true
    assert.equal((await mailbox.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} }) as { isError: boolean }).isError, true)
    f.state.oversized = false; f.state.malformed = true
    assert.equal((await mailbox.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} }) as { isError: boolean }).isError, true)
    f.state.malformed = false; f.state.revoked = true
    assert.equal((await mailbox.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} }) as { isError: boolean }).isError, true)
    const before = f.state.requests; f.state.revoked = false
    await mailbox.request({ operation: 'call', name: 'mailbox_send', arguments: { ...args, key: randomUUID() } })
    assert.equal(f.state.requests, before); assert.equal(f.state.writes, 1)
  } finally { await mailbox.close() }
  const stopped = fixture(), other = (await stopped.create())!
  stopped.state.cancelled = true
  const before = stopped.state.requests
  assert.equal((await other.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} }) as { isError: boolean }).isError, true)
  assert.equal(stopped.state.requests, before); stopped.abort.abort(); await other.close()
})

for (const kind of ['claude_code', 'codex'] as const) test(`${kind} actual fake CLI and host catalogue preserve a frozen one-tool subset`, async () => {
  const f = fixture(); f.state.allowed = ['mailbox_inbox']
  const mailbox = (await f.create())!, stateDir = join(retained, kind + '-subset', 'state'), home = join(retained, kind + '-subset', 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const before = f.state.requests
  assert.equal((await mailbox.request({ operation: 'call', name: 'mailbox_send', arguments: { to: randomUUID(), key: randomUUID(), text: 'Not granted' } }) as { isError: boolean }).isError, true)
  assert.equal(f.state.requests, before)
  const log = createLogger({ level: 'silent' })
  const adapter = kind === 'codex'
    ? new CodexAdapter({ sandbox: new NoSandbox(), stateDir, binary: resolve('test/fakes/fake-codex.mjs'), userHome: home })
    : new ClaudeAdapter({ stateDir, binary: resolve('test/fakes/fake-claude.mjs'), configDir: join(home, '.claude') })
  try {
    const session = await adapter.start({ runId: f.assignment.runId, cwd: resolve('../..'), env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }), log, mailbox,
      prompt: 'MAILBOX_TEST ' + JSON.stringify([{ name: '__mailbox_catalog' }, { name: 'mailbox_inbox' }, { name: 'mailbox_send', arguments: { to: randomUUID(), key: randomUUID(), text: 'Not granted' } }]) })
    let text = ''
    for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') text += event.chunk.delta
    const output = JSON.parse(text)
    assert.deepEqual(output.mailboxResults[0].result.tools.filter((tool: { name: string }) => tool.name.startsWith('mailbox_')).map((tool: { name: string }) => tool.name), ['mailbox_inbox'])
    assert.ok(output.mailboxResults[2].error || output.mailboxResults[2].result?.isError)
    assert.equal(f.state.writes, 0)
    assert.equal(text.includes(f.token), false)
  } finally { await mailbox.close() }
})

for (const kind of ['claude_code', 'codex'] as const) test(`${kind} fake CLI has no mailbox configuration or advertised tools by default`, async () => {
  const stateDir = join(retained, kind + '-off', 'state'), home = join(retained, kind + '-off', 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const log = createLogger({ level: 'silent' })
  const adapter = kind === 'codex'
    ? new CodexAdapter({ sandbox: new NoSandbox(), stateDir, binary: resolve('test/fakes/fake-codex.mjs'), userHome: home })
    : new ClaudeAdapter({ stateDir, binary: resolve('test/fakes/fake-claude.mjs'), configDir: join(home, '.claude') })
  const session = await adapter.start({ runId: randomUUID(), cwd: resolve('../..'), env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }), log, prompt: 'MAILBOX_TEST ' + JSON.stringify([{ name: '__mailbox_catalog' }, { name: 'mailbox_inbox' }]) })
  const chunks = []
  for await (const event of session.events()) chunks.push(event)
  const text = chunks.flatMap(event => event.type === 'chunk' && event.chunk.type === 'text-delta' ? [event.chunk.delta] : []).join('')
  const output = JSON.parse(text)
  assert.ok(!output.mcpConfig.args.includes('--mailbox-socket'))
  assert.ok(output.mailboxResults[0].result.tools.every((tool: { name: string }) => !tool.name.startsWith('mailbox_')))
  assert.ok(output.mailboxResults[1].error || output.mailboxResults[1].result?.isError)
})

test('hosted source preserves original socket mounts/network isolation and passes host callbacks only through existing adapters', () => {
  const source = readFileSync('src/subscription-hosted-runner.ts', 'utf8')
  assert.match(source, /adapter\.start\(options\)/)
  assert.match(source, /adapter\.resume\(previous\.sessionId, options\)/)
  assert.doesNotMatch(source, /mailboxSocket|mikka-mailbox\.sock/)
  const bootstrap = readFileSync('src/agents/native-container.mjs', 'utf8')
  assert.doesNotMatch(bootstrap, /mailbox|allowAllUnixSockets/)
})

test('stop aborts a genuinely pending host request and prevents another request during CLI grace', async () => {
  const f = fixture(); let entered!: () => void
  const waiting = new Promise<void>(resolveEntered => { entered = resolveEntered })
  const transport: typeof fetch = async (url, init) => {
    const packet = JSON.parse(String(init?.body))
    if (packet.method !== 'tools/call') return f.transport(url, init)
    entered()
    return new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!
      if (signal.aborted) reject(new Error('Stopped'))
      else signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })
    })
  }
  const mailbox = (await createRunMailbox({ assignment: f.assignment, endpoint, signal: f.abort.signal, check: () => {}, fetch: transport }))!
  const attempt = mailbox.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} })
  await waiting; await mailbox.close()
  assert.equal(f.abort.signal.aborted, false, 'Cancellation must not wait for the run abort grace')
  assert.equal((await attempt as { isError: boolean }).isError, true)
  assert.equal((await mailbox.request({ operation: 'list' }) as { isError: boolean }).isError, true)
  await mailbox.close()
})

test('Codex unaudited versions and mailbox-enabled history resume fail closed without a fallback thread', async () => {
  const f = fixture(), mailbox = (await f.create())!
  const dir = join(retained, 'unsupported'); mkdirSync(dir, { recursive: true, mode: 0o700 })
  const original = readFileSync('test/fakes/fake-codex.mjs', 'utf8')
  writeFileSync(join(dir, 'mcp-call.mjs'), readFileSync('test/fakes/mcp-call.mjs'))
  const log = createLogger({ level: 'silent' }), home = join(dir, 'home'); mkdirSync(home)
  try {
    for (const version of ['0.162.0', '0.163.0-alpha', '0.164.0']) {
      const binary = join(dir, 'codex-' + version + '.mjs')
      writeFileSync(binary, original.replace('codex_cli_rs/0.163.0', 'codex_cli_rs/' + version), { mode: 0o700 })
      const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir: join(dir, version), binary, userHome: home })
      const options = { runId: randomUUID(), cwd: resolve('../..'), env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }), log, mailbox, prompt: 'No provider invocation' }
      await assert.rejects(adapter.start(options), /audited Codex0.163.0/)
      await assert.rejects(adapter.resume('another-history', options), /fresh Codex thread/)
    }
    assert.equal(f.state.writes, 0)
  } finally { await mailbox.close() }
})

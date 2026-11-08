import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { anonymousClaudeHintSchema } from '@mikka/protocol/claude-startup'
import { anonymousCodexHintSchema } from '@mikka/protocol/codex-startup'
import { consumeCloudBootstrap, installCloudCredential, watchCloudBootstraps } from '../src/cloud-bootstrap'
import { holdCandidateRegistration, publishCandidateBootstrap, readCandidateStart, waitForCandidateStart } from '../../../scripts/e2b/acceptance-bootstrap.mts'
import { cleanupTempDirs, tempDir } from './helpers'

afterEach(cleanupTempDirs)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function fixture(harness: 'claude_code' | 'codex') {
  const directory = tempDir(), runId = randomUUID()
  const config = { deviceId: randomUUID(), workspaceId: randomUUID(), credential: 'orv_' + 'a'.repeat(43),
    server: 'https://fixture.example/mikka', collectCliTiming: true }
  const raw = JSON.stringify(config), schema = harness === 'codex' ? anonymousCodexHintSchema : anonymousClaudeHintSchema
  const hint = schema.parse({ version: 1, runId, bootstrapSha256: hash(raw),
    profile: harness === 'codex' ? 'cloud_repository_codex_0166_v1' : 'cloud_repository_claude_v1',
    model: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', effort: 'low', kind: 'implement',
    github: true, diagnostics: true, policy: defaultRunPolicy(), mailboxTools: ['mailbox_inbox'],
    decisionCatalogue: { version: 1, tool: { name: 'record_decision', title: 'Fixture', description: 'Fixture decision',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { idempotentHint: true } } } })
  const projected = { version: 1, authority: 'none', deviceId: config.deviceId, workspaceId: config.workspaceId, harness, hint }
  return { directory, runId, config, raw, projected, hint }
}

it.each(['claude_code', 'codex'] as const)('candidate %s publication reaches the real one-use bootstrap decoder exactly once', async harness => {
  const f = fixture(harness), results: ReturnType<typeof consumeCloudBootstrap>[] = []
  let resolve!: () => void, reject!: (error: unknown) => void
  const consumed = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const close = watchCloudBootstraps(f.directory, async () => {
    results.push(consumeCloudBootstrap(join(f.directory, 'bootstrap.json'))); resolve()
  }, reject)
  try {
    const receipt = await publishCandidateBootstrap(f.directory, f.raw, f.projected, harness)
    await consumed
    process.emit('SIGUSR1')
    expect(results).toHaveLength(1)
    const result = results[0]!
    expect(result.collectCliTiming).toBe(true)
    expect(result.initialRunId).toBe(f.runId)
    expect(harness === 'codex' ? result.anonymousCodexHint : result.anonymousClaudeHint).toEqual(f.hint)
    expect(receipt).toEqual({ version: 1, runId: f.runId, harness, bootstrapSha256: hash(f.raw), hintSha256: hash(JSON.stringify(f.hint)) })
    const installed = tempDir()
    expect(await installCloudCredential(installed, result)).toBe('start')
    expect(JSON.parse(readFileSync(join(installed, 'device.json'), 'utf8'))).toEqual({
      deviceId: f.config.deviceId, workspaceId: f.config.workspaceId, credential: f.config.credential,
    })
    expect(existsSync(join(f.directory, 'bootstrap.json'))).toBe(false)
    expect(existsSync(join(f.directory, 'initial-run.json'))).toBe(false)
    expect(existsSync(join(f.directory, harness === 'codex' ? 'anonymous-codex.json' : 'anonymous-claude.json'))).toBe(false)
  } finally { close() }
})

it('the start watcher handles publication before and after watch creation without polling', async () => {
  for (const before of [false, true]) {
    const f = fixture('claude_code'), path = join(f.directory, 'start.json')
    if (before) writeFileSync(path, JSON.stringify(f.projected), { mode: 0o600 })
    const waiting = waitForCandidateStart(path, new AbortController().signal, 1000)
    if (!before) {
      await writeFile(path + '.next', JSON.stringify(f.projected), { mode: 0o600 })
      await rename(path + '.next', path)
    }
    expect(await waiting).toEqual(f.projected)
  }
})

it('wrong device, workspace, credential generation or non-literal diagnostic opt-in cannot publish identity', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.projected.deviceId = randomUUID() },
    (f: ReturnType<typeof fixture>) => { f.projected.workspaceId = randomUUID() },
    (f: ReturnType<typeof fixture>) => { f.projected.hint.bootstrapSha256 = 'f'.repeat(64) },
    (f: ReturnType<typeof fixture>) => { f.projected.hint.diagnostics = false },
    (f: ReturnType<typeof fixture>) => { f.raw = JSON.stringify({ ...f.config, collectCliTiming: false }) },
  ]) {
    const f = fixture('claude_code'); mutate(f)
    await expect(publishCandidateBootstrap(f.directory, f.raw, f.projected, 'claude_code')).rejects.toThrow()
    expect(existsSync(join(f.directory, 'bootstrap.json'))).toBe(false)
  }
})

it('a previous identity, public file, symlink, timeout or abort is fail-closed', async () => {
  const f = fixture('claude_code'), path = join(f.directory, 'start.json')
  writeFileSync(join(f.directory, 'bootstrap.json'), 'previous', { mode: 0o600 })
  await expect(publishCandidateBootstrap(f.directory, f.raw, f.projected, 'claude_code')).rejects.toThrow('already_present')
  expect(readFileSync(join(f.directory, 'bootstrap.json'), 'utf8')).toBe('previous')
  writeFileSync(path, JSON.stringify(f.projected), { mode: 0o644 })
  expect(() => readCandidateStart(path)).toThrow('file_invalid')
  chmodSync(path, 0o600); symlinkSync(path, path + '.link')
  expect(() => readCandidateStart(path + '.link')).toThrow()
  const signal = new AbortController(); signal.abort(Error('cancelled'))
  const fresh = fixture('codex')
  await expect(waitForCandidateStart(join(fresh.directory, 'start.json'), signal.signal)).rejects.toThrow('cancelled')
  await expect(publishCandidateBootstrap(fresh.directory, fresh.raw, fresh.projected, 'codex', signal.signal)).rejects.toThrow('cancelled')
  expect(existsSync(join(fresh.directory, 'bootstrap.json'))).toBe(false)
  await expect(waitForCandidateStart(join(fresh.directory, 'start.json'), new AbortController().signal, 5)).rejects.toThrow('timeout')
})

it('the actual bootstrap parser defaults diagnostics off and accepts only an explicit boolean true', () => {
  for (const value of [undefined, true, false, 'true', 1]) {
    const f = fixture('codex'), file = join(f.directory, 'bootstrap.json')
    const { collectCliTiming: _, ...config } = f.config
    writeFileSync(file, JSON.stringify({ ...config, ...(value === undefined ? {} : { collectCliTiming: value }) }), { mode: 0o600 })
    if (value === undefined || value === true) expect(consumeCloudBootstrap(file).collectCliTiming).toBe(value)
    else expect(() => consumeCloudBootstrap(file)).toThrow()
  }
})

it('normal gateway presence handles work signals without claiming and closes before handoff', async () => {
  class Socket {
    readyState = 0
    sent: string[] = []
    closed = false
    listeners = new Map<string, Set<(event: { data?: unknown; code?: number }) => void>>()
    send(value: string) { this.sent.push(value) }
    close() { this.closed = true; this.readyState = 3 }
    addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void) {
      const listeners = this.listeners.get(type) ?? new Set()
      listeners.add(listener); this.listeners.set(type, listeners)
    }
    removeEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void) { this.listeners.get(type)?.delete(listener) }
    emit(type: string, event: { data?: unknown; code?: number } = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }
  }
  for (const disconnect of [false, true]) {
    const socket = new Socket(), deviceId = randomUUID(), lifetime = new AbortController()
    let tickets = 0
    const opening = holdCandidateRegistration({ deviceGateway: async id => {
      tickets++; expect(id).toBe(deviceId)
      return { url: 'wss://fixture.invalid/device', protocol: 'private-fixture-ticket' }
    } }, deviceId, lifetime.signal, () => {
      queueMicrotask(() => { socket.readyState = 1; socket.emit('open') })
      return socket
    })
    const presence = await opening
    socket.emit('message', { data: 'work' })
    await Promise.resolve()
    expect(tickets).toBe(1)
    expect(socket.sent).toEqual([])
    if (disconnect) {
      socket.emit('error')
      await Promise.resolve(); await Promise.resolve()
      expect(presence.signal.aborted).toBe(true)
    }
    await presence.close()
    expect(socket.closed).toBe(true)
  }
})

import { spawn, execFileSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ClaudeAdapter } from '../src/adapters/claude'
import { prepareAgentStart, type ClaudePrewarmBinding } from '../src/adapters/claude-prewarm'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import type { StartOptions } from '../src/adapters/types'
import { createLogger } from '../src/log'
import { createRunMailbox } from '../src/run-mailbox'
import { stopGroup } from '../src/process-group'
import { cleanupTempDirs, tempDir } from './helpers'
import type { RunAssignment } from '@mikka/protocol'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); cleanupTempDirs() })

async function fixture(mode = 'normal') {
  const root = realpathSync(tempDir('mikka-prewarm-adapter-')), stateDir = join(root, 'adapters'), cwd = join(root, 'checkout'), home = join(root, 'home')
  mkdirSync(stateDir); mkdirSync(home)
  const runId = randomUUID(), sessionId = randomUUID()
  const signal = new AbortController(), children: ChildProcess[] = [], events: Array<Record<string, unknown>> = []
  let live = true
  const approval = new ToolApprovalGate(runId, { isLive: () => live }, 'push')
  const watchers = new Set<() => void>()
  const wait = (predicate: (event: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((done, reject) => {
    const check = () => { const value = events.find(predicate); if (value) { clearTimeout(timer); watchers.delete(check); done(value) } }
    const timer = setTimeout(() => { watchers.delete(check); reject(Error('Expected anonymous process event')) }, 5000)
    watchers.add(check); check()
  })
  const binding: ClaudePrewarmBinding = { runId, sessionId, cwd, deviceId: randomUUID(), bindingId: randomUUID(),
    ownerId: randomUUID(), workspaceId: randomUUID(), consumerId: randomUUID(), accountId: 'fixture-account',
    revision: 1, model: 'claude-haiku-5-5', policyHash: null }
  const endpoint = new URL('https://mikka.invalid/api/mcp')
  const transport = vi.fn<typeof fetch>(async () => { throw Error('No business HTTP expected') })
  const mailbox = await createRunMailbox({ assignment: { mcp: { url: endpoint.href, token: 'mkw_' + 'x'.repeat(43), mailbox: true,
    mailboxCatalogue: { version: 1, transport: 'mikka-stateless-2025-06-18', tools: ['mailbox_inbox', 'mailbox_ack'] } } } as RunAssignment,
    endpoint, signal: signal.signal, check: () => { if (!live) throw Error('Cancelled') }, fetch: transport })
  const options: StartOptions = { runId, cwd, prompt: 'The complete anonymous task', env: { HOME: home, PATH: process.env.PATH! },
    log: createLogger({ level: 'silent' }), machineEnvironment: true, toolApproval: approval, model: binding.model,
    kind: 'implement', mailbox }
  const adapter = new ClaudeAdapter({ stateDir, subscriptionAuth: { automaticRefresh: true, accountId: binding.accountId,
    token: async () => ({ accountId: binding.accountId, accessToken: 'synthetic-test-token', expiresAt: new Date(Date.now() + 300_000).toISOString() }) },
    spawnHosted(config) {
      const child = spawn(process.execPath, [resolve(import.meta.dirname, 'fakes/fake-claude-prewarm.mjs'), ...config.args, '--fixture-mode', mode],
        { cwd: config.cwd, env: config.env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
      children.push(child); child.stderr?.resume()
      child.on('message', value => { events.push(value as Record<string, unknown>); for (const notify of watchers) notify() })
      config.signal?.addEventListener('abort', () => { void stopGroup(child, 1000) }, { once: true })
      return child as ChildProcessWithoutNullStreams
    },
  })
  const stop = async () => { await Promise.all(children.map(child => stopGroup(child, 1000))) }
  const handle = prepareAgentStart(signal.signal, control => adapter.startPrepared(options, binding, control, stop))
  cleanups.push(async () => { await handle.cancel(); await mailbox?.close(); await stop() })
  const checkout = () => {
    mkdirSync(cwd); execFileSync('git', ['init', '-q'], { cwd })
    writeFileSync(join(cwd, 'setup-finished'), 'ready')
  }
  return { root, options, binding, handle, events, children, wait, checkout, transport,
    stop: () => { live = false; approval.revoke(); signal.abort() } }
}

it('prepares the real SDK before clone, registers the entire mailbox once, then sends the final prompt only after claimed account validation', async () => {
  const f = await fixture(); await f.handle.ready
  expect(existsSync(f.options.cwd)).toBe(false)
  expect(await f.wait(event => event.event === 'spawn')).toMatchObject({ awaitingClaim: true, home: f.options.env.HOME, model: f.options.model })
  expect(f.events.some(event => event.event === 'user' || event.type === 'claim_session')).toBe(false)
  f.checkout()
  const session = await f.handle.start({ ...f.options, prompt: 'Final task plus fully materialized attachments' })
  expect(readFileSync(join(f.options.cwd, 'setup-finished'), 'utf8')).toBe('ready')
  expect(await f.wait(event => event.event === 'catalogue')).toMatchObject({ names: ['mailbox_inbox', 'mailbox_ack'] })
  expect(await f.wait(event => event.event === 'user')).toMatchObject({ sessionId: f.binding.sessionId, text: 'Final task plus fully materialized attachments' })
  expect(f.children).toHaveLength(1); expect(f.transport).not.toHaveBeenCalled()
  await session.cancel()
})

it('drains a parked CLI on clone failure without claiming or sending a task', async () => {
  const f = await fixture(); await f.handle.ready
  await f.handle.cancel()
  expect(f.events.some(event => event.type === 'claim_session' || event.event === 'user')).toBe(false)
  expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  await expect(f.handle.start(f.options)).rejects.toThrow('closed')
})

it('falls back exactly once only for an actual project-settings claim refusal, after draining the spare', async () => {
  const f = await fixture('project_settings'); await f.handle.ready; f.checkout()
  const session = await f.handle.start(f.options)
  const frames = f.events.filter(event => event.event === 'spawn')
  expect(frames).toHaveLength(2)
  expect(frames.map(frame => frame.awaitingClaim)).toEqual([true, false])
  expect(f.children[0].exitCode !== null || f.children[0].signalCode !== null).toBe(true)
  expect(await f.wait(event => event.event === 'user')).toMatchObject({ sessionId: f.binding.sessionId, text: f.options.prompt })
  expect(f.events.filter(event => event.event === 'user')).toHaveLength(1)
  await session.cancel()
})

it.each(['refuse_claim', 'wrong_cwd', 'wrong_session', 'wrong_account'])('does not fallback or send a task on %s', async mode => {
  const f = await fixture(mode); await f.handle.ready; f.checkout()
  await expect(f.handle.start(f.options)).rejects.toThrow()
  expect(f.children).toHaveLength(1)
  expect(f.events.filter(event => event.event === 'user')).toHaveLength(0)
})

it('rejects fixed environment drift and stops without a user frame', async () => {
  const f = await fixture(); await f.handle.ready; f.checkout()
  await expect(f.handle.start({ ...f.options, env: { ...f.options.env, NEW_ENV: 'changed' } })).rejects.toThrow('options changed')
  expect(f.events.filter(event => event.event === 'user')).toHaveLength(0)
  expect(f.children).toHaveLength(1)
})

it('a local revoke during clone stops the already parked native process and refuses final consumption', async () => {
  const f = await fixture(); await f.handle.ready
  f.stop(); await f.handle.cancel()
  expect(f.children[0].exitCode !== null || f.children[0].signalCode !== null).toBe(true)
  await expect(f.handle.start(f.options)).rejects.toThrow()
  expect(f.events.filter(event => event.event === 'user')).toHaveLength(0)
})

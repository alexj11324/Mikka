import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { CodexAdapter } from '../src/adapters/codex'
import type { AgentSession, StartOptions } from '../src/adapters/types'
import { NoSandbox } from '../src/agents/sandbox'
import { ToolApprovalGate } from '../src/agents/tool-approval'
import { buildChildEnv } from '../src/env'
import { createLogger } from '../src/log'
import type { RunMailbox } from '../src/run-mailbox'

// Real adapter + synthetic CLI. Official 0.163.0 and 0.166.0 loopback
// Responses fixtures separately verify the rollout catalogue and native resume.
const root = mkdtempSync(join(tmpdir(), 'mikka-codex-mailbox-resume-'))
const cwd = join(root, 'worktree')
mkdirSync(cwd)
execFileSync('git', ['init', '-q', cwd], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' })
const log = createLogger({ level: 'silent' })
const binary = resolve('test/fakes/fake-codex.mjs')
const prompt = 'MAILBOX_RESUME_TEST ' + JSON.stringify([{ name: 'mailbox_inbox', arguments: {} }])

function transport(scope: string, name = 'mailbox_inbox') {
  const calls: unknown[] = []
  let live = true
  const mailbox: RunMailbox = {
    tools: [{ name, description: 'Synthetic current-run inbox', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    async request(body) {
      assert.equal(live, true, 'An ended run cannot receive the next run callback')
      calls.push(body)
      return { content: [{ type: 'text', text: scope }] }
    },
    async close() { live = false },
  }
  return { mailbox, calls }
}

function fixture() {
  const dir = join(root, randomUUID()), stateDir = join(dir, 'adapters'), home = join(dir, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const adapter = () => new CodexAdapter({ stateDir, sandbox: new NoSandbox(), binary })
  const options = (runId: string, mailbox: RunMailbox): StartOptions => ({
    runId, cwd, mailbox, prompt, log,
    env: buildChildEnv({ host: { PATH: process.env.PATH, HOME: home } }),
    toolApproval: new ToolApprovalGate(runId, { isLive: () => true }),
  })
  const codexHome = (runId: string) => join(stateDir, 'runs', runId, 'codex-home')
  const receipt = (runId: string) => join(stateDir, 'codex-mailbox', runId + '.json')
  const controls = (runId: string, value: Record<string, unknown>) => {
    mkdirSync(codexHome(runId), { recursive: true })
    writeFileSync(join(codexHome(runId), 'fixture-control.json'), JSON.stringify(value))
  }
  const trace = (runId: string) => {
    const file = join(codexHome(runId), 'fixture-protocol.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  }
  return { stateDir, adapter, options, codexHome, receipt, controls, trace }
}

async function drain(session: AgentSession) {
  let output = ''
  const exits: string[] = []
  for await (const event of session.events()) {
    if (event.type === 'chunk' && event.chunk.type === 'text-delta') output += event.chunk.delta
    if (event.type === 'exit') exits.push(event.outcome)
  }
  assert.deepEqual(exits, ['succeeded'])
  return output
}

async function original(f: ReturnType<typeof fixture>, nativeVersion = '0.163.0') {
  const runId = randomUUID(), first = transport('original')
  f.controls(runId, { userAgent: `mikka/${nativeVersion} (Synthetic Linux)` })
  const session = await f.adapter().start(f.options(runId, first.mailbox))
  await drain(session)
  assert.equal(first.calls.length, 1)
  await first.mailbox.close()
  return { runId, sessionId: session.sessionId, first }
}

test('Codex mailbox continues the original history in a new run and restarts with only the current transport', { timeout: 20000 }, async () => {
  const f = fixture(), source = await original(f), childRunId = randomUUID(), current = transport('current')
  const options = { ...f.options(childRunId, current.mailbox), requireSessionResume: true,
    continueSession: { runId: source.runId, sessionId: source.sessionId, message: prompt } }
  f.controls(childRunId, { userAgent: 'mikka/0.163.0 (Synthetic Linux)' })
  const continued = await f.adapter().start(options)
  assert.equal(continued.sessionId, source.sessionId)
  assert.ok((await drain(continued)).includes('current'))
  assert.equal(current.calls.length, 1)
  assert.equal(source.first.calls.length, 1)
  const requests = f.trace(childRunId)
  assert.deepEqual(requests.filter(item => item.method.startsWith('thread/')), [{ method: 'thread/resume', dynamicToolsPresent: false }])
  const recorded = JSON.parse(readFileSync(f.receipt(childRunId), 'utf8'))
  assert.equal(recorded.runId, childRunId)
  assert.equal(recorded.threadId, source.sessionId)
  assert.equal(existsSync(join(f.codexHome(childRunId), 'codex-mailbox')), false)
  await current.mailbox.close()

  const restarted = transport('restarted')
  f.controls(childRunId, { mailboxOnRestart: true })
  const resumed = await f.adapter().resume(source.sessionId, f.options(childRunId, restarted.mailbox))
  assert.equal(resumed.sessionId, source.sessionId)
  assert.ok((await drain(resumed)).includes('restarted'))
  assert.equal(restarted.calls.length, 1)
  assert.equal(current.calls.length, 1)
  const nextId = randomUUID(), last = transport('after-restart')
  const next = await f.adapter().start({ ...f.options(nextId, last.mailbox), continueSession: { runId: childRunId, sessionId: source.sessionId, message: prompt } })
  await drain(next)
  assert.equal(next.sessionId, source.sessionId)
  assert.equal(last.calls.length, 1)
  assert.equal(source.first.calls.length, 1)
  await restarted.mailbox.close(); await last.mailbox.close()
})

for (const nativeVersion of ['0.166.0', '0.167.0'] as const) test(`Codex ${nativeVersion} records its actual version and resumes the same mailbox thread with the current transport`, { timeout: 20000 }, async () => {
  const f = fixture(), source = await original(f, nativeVersion), childRunId = randomUUID(), current = transport('current')
  assert.ok(existsSync(f.receipt(source.runId)), 'The verified native release must record resume evidence')
  assert.equal(JSON.parse(readFileSync(f.receipt(source.runId), 'utf8')).nativeVersion, nativeVersion)
  f.controls(childRunId, { userAgent: `mikka/${nativeVersion} (Synthetic Linux)` })
  const continued = await f.adapter().start({ ...f.options(childRunId, current.mailbox), requireSessionResume: true,
    continueSession: { runId: source.runId, sessionId: source.sessionId, message: prompt } })
  assert.equal(continued.sessionId, source.sessionId)
  assert.ok((await drain(continued)).includes('current'))
  assert.equal(current.calls.length, 1)
  assert.equal(source.first.calls.length, 1)
  assert.deepEqual(f.trace(childRunId).filter(item => item.method.startsWith('thread/')), [{ method: 'thread/resume', dynamicToolsPresent: false }])
  const recorded = JSON.parse(readFileSync(f.receipt(childRunId), 'utf8'))
  assert.equal(recorded.nativeVersion, nativeVersion)
  assert.equal(recorded.runId, childRunId)
  assert.equal(recorded.threadId, source.sessionId)
  await current.mailbox.close()

  const restarted = transport('restarted')
  f.controls(childRunId, { userAgent: `mikka/${nativeVersion} (Synthetic Linux)`, mailboxOnRestart: true })
  const resumed = await f.adapter().resume(source.sessionId, f.options(childRunId, restarted.mailbox))
  assert.equal(resumed.sessionId, source.sessionId)
  assert.ok((await drain(resumed)).includes('restarted'))
  assert.equal(restarted.calls.length, 1)
  assert.equal(current.calls.length, 1)
  const restartedReceipt = JSON.parse(readFileSync(f.receipt(childRunId), 'utf8'))
  assert.equal(restartedReceipt.nativeVersion, nativeVersion)
  assert.equal(restartedReceipt.threadId, source.sessionId)
  await restarted.mailbox.close()
})

test('Codex mailbox resume rejects unverified cross-version history before thread/resume or a native turn', { timeout: 20000 }, async t => {
  for (const [originalVersion, currentVersion] of [
    ['0.163.0', '0.166.0'], ['0.166.0', '0.163.0'],
    ['0.163.0', '0.167.0'], ['0.167.0', '0.163.0'],
    ['0.166.0', '0.167.0'], ['0.167.0', '0.166.0'],
  ]) await t.test(originalVersion + ' to ' + currentVersion, async () => {
    const f = fixture(), source = await original(f, originalVersion), nextId = randomUUID(), current = transport('current')
    assert.ok(existsSync(f.receipt(source.runId)), 'The original verified release must have a real host receipt')
    assert.equal(JSON.parse(readFileSync(f.receipt(source.runId), 'utf8')).nativeVersion, originalVersion)
    f.controls(nextId, { userAgent: `mikka/${currentVersion} (Synthetic Linux)` })
    await assert.rejects(f.adapter().start({ ...f.options(nextId, current.mailbox),
      continueSession: { runId: source.runId, sessionId: source.sessionId, message: prompt } }), /Run mailbox/)
    assert.deepEqual(f.trace(nextId), [])
    assert.equal(current.calls.length, 0)
    assert.equal(existsSync(f.receipt(nextId)), false)
    await current.mailbox.close()
  })
})

test('Codex mailbox resume rejects missing or changed capability evidence before any native turn', { timeout: 30000 }, async t => {
  for (const nativeVersion of ['0.163.0', '0.167.0'] as const) for (const change of ['missing-receipt', 'catalogue', 'header-catalogue', 'header-schema', 'header-session', 'missing-history', 'receipt-path', 'receipt-run', 'receipt-session', 'receipt-version', 'history-link'] as const) await t.test(nativeVersion + ' ' + change, async () => {
    const f = fixture(), source = await original(f, nativeVersion), nextId = randomUUID(), current = transport('current', change === 'catalogue' ? 'mailbox_sent' : 'mailbox_inbox')
    f.controls(nextId, { userAgent: `mikka/${nativeVersion} (Synthetic Linux)` })
    const history = join(f.codexHome(source.runId), 'sessions', source.sessionId + '.jsonl')
    if (change === 'missing-receipt') rmSync(f.receipt(source.runId), { force: true })
    if (change === 'header-catalogue' || change === 'header-schema' || change === 'header-session') {
      const header = JSON.parse(readFileSync(history, 'utf8'))
      if (change === 'header-catalogue') header.payload.dynamic_tools[0].name = 'mailbox_sent'
      else if (change === 'header-schema') header.payload.dynamic_tools[0].inputSchema.additionalProperties = true
      else header.payload.id = 'foreign-thread'
      writeFileSync(history, JSON.stringify(header) + '\n')
    }
    if (change === 'missing-history') rmSync(history)
    if (change === 'receipt-path' || change === 'receipt-run' || change === 'receipt-session' || change === 'receipt-version') {
      const file = f.receipt(source.runId)
      // The old implementation has no receipt; the positive case above is
      // the regression red. This synthetic host record still must not grant
      // a path outside the retained history directories.
      mkdirSync(join(f.stateDir, 'codex-mailbox'), { recursive: true })
      const receipt = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, runId: source.runId, threadId: source.sessionId }
      writeFileSync(file, JSON.stringify({ ...receipt, ...(change === 'receipt-path' ? { historyPath: '../outside.jsonl' } : change === 'receipt-run' ? { runId: randomUUID() } : change === 'receipt-version' ? { nativeVersion: '0.164.0' } : { threadId: 'foreign-thread' }) }))
    }
    if (change === 'history-link') {
      const target = join(f.stateDir, 'synthetic-outside-history.jsonl')
      writeFileSync(target, readFileSync(history)); rmSync(history); symlinkSync(target, history)
    }
    await assert.rejects(f.adapter().start({ ...f.options(nextId, current.mailbox), continueSession: { runId: source.runId, sessionId: source.sessionId, message: prompt } }), /Run mailbox/)
    assert.equal(current.calls.length, 0)
    assert.equal(f.trace(nextId).filter(item => item.method === 'turn/start' || item.method === 'thread/start').length, 0)
    await current.mailbox.close()
  })
})

test('Codex mailbox resume never substitutes a new thread after native refusal or a changed SID', { timeout: 20000 }, async t => {
  for (const control of ['refuseResume', 'differentThread'] as const) await t.test(control, async () => {
    const f = fixture(), source = await original(f), nextId = randomUUID(), current = transport('current')
    f.controls(nextId, { [control]: true })
    await assert.rejects(f.adapter().start({ ...f.options(nextId, current.mailbox), continueSession: { runId: source.runId, sessionId: source.sessionId, message: prompt } }))
    assert.equal(current.calls.length, 0)
    // No requireSessionResume flag here: mailbox itself needs the original
    // conversation, even on an otherwise ordinary API-key continuation.
    assert.deepEqual(f.trace(nextId).map(item => item.method), ['thread/resume'])
    await current.mailbox.close()
  })
})

test('a previous-turn callback during native resume cannot use the current run mailbox', { timeout: 10000 }, async () => {
  const f = fixture(), source = await original(f), nextId = randomUUID(), current = transport('current')
  f.controls(nextId, { staleDuringResume: true })
  const session = await f.adapter().start({ ...f.options(nextId, current.mailbox), continueSession: { runId: source.runId, sessionId: source.sessionId, message: prompt } })
  await drain(session)
  assert.equal(session.sessionId, source.sessionId)
  assert.equal(current.calls.length, 1, 'Only the newly started turn reaches the current transport')
  assert.equal(f.trace(nextId).find(item => item.staleDuringResume)?.staleDuringResume.success, false)
  await current.mailbox.close()
})

test('missing native resume evidence does not prevent an otherwise supported fresh mailbox thread', { timeout: 10000 }, async () => {
  const f = fixture(), runId = randomUUID(), current = transport('fresh')
  f.controls(runId, { omitRolloutPath: true })
  const session = await f.adapter().start(f.options(runId, current.mailbox))
  await drain(session)
  assert.equal(current.calls.length, 1)
  assert.equal(existsSync(f.receipt(runId)), false)
  await current.mailbox.close()
  const nextId = randomUUID(), later = transport('later')
  await assert.rejects(f.adapter().start({ ...f.options(nextId, later.mailbox), continueSession: { runId, sessionId: session.sessionId, message: prompt } }), /Run mailbox/)
  assert.equal(later.calls.length, 0)
  assert.deepEqual(f.trace(nextId), [])
  await later.mailbox.close()
})

for (const [unverifiedVersion, malformedVersion] of [['0.164.0', '0.163.0-alpha'], ['0.168.0', '0.167.0-alpha']] as const) test(`unverified Codex ${unverifiedVersion} keeps fresh-thread behavior but cannot resume a mailbox thread`, { timeout: 20000 }, async () => {
  const f = fixture(), runId = randomUUID(), fresh = transport('fresh')
  f.controls(runId, { userAgent: `mikka/${unverifiedVersion} (Synthetic Linux)` })
  const session = await f.adapter().start(f.options(runId, fresh.mailbox))
  await drain(session)
  assert.equal(fresh.calls.length, 1)
  assert.equal(existsSync(f.receipt(runId)), false)
  await fresh.mailbox.close()

  const source = await original(f), nextId = randomUUID(), current = transport('current')
  f.controls(nextId, { userAgent: `mikka/${malformedVersion} (Synthetic Linux)` })
  await assert.rejects(f.adapter().start({ ...f.options(nextId, current.mailbox), continueSession: { runId: source.runId, sessionId: source.sessionId, message: prompt } }), /Run mailbox/)
  assert.deepEqual(f.trace(nextId), [])
  assert.equal(current.calls.length, 0)
  await current.mailbox.close()
})

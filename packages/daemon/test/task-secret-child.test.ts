import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { taskSecretAccessSchema } from '@mikka/protocol/task-secrets'
import type { AgentAdapter, AgentSession, StartOptions } from '../src/adapters/types'
import { createLogger } from '../src/log'
import { Outbox } from '../src/outbox'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor } from '../src/runs/supervisor'
import { MemoryServer } from '../src/server-link'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

const execute = promisify(execFile)
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
  cleanupTempDirs()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

interface ChildCapture {
  env: Record<string, string>
  status: number
  body: string
}

const SDK_CHILD = `
const endpoints = JSON.parse(process.env.MIKKA_SECRET_ENDPOINTS);
const response = await fetch(endpoints.SERVICE_API_KEY + '/v1/widgets', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + process.env.SDK_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'real-node-child' }),
});
process.stdout.write(JSON.stringify({ env: { ...process.env }, status: response.status, body: await response.text() }));
`

async function sdkChild(options: StartOptions): Promise<ChildCapture> {
  // Use the real supervisor's complete child environment. Filtering it here
  // would conceal a runtime leak; the only addition is the public SDK dummy.
  const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '-e', SDK_CHILD], {
    cwd: options.cwd,
    env: { ...options.env, SDK_KEY: 'mikka-protected' },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
  })
  expect(stderr).toBe('')
  return JSON.parse(stdout) as ChildCapture
}

it('a real supervisor child uses renewed opaque grants while native credentials and both journal generations stay protected', async () => {
  const canary = `third-party-canary-${randomBytes(24).toString('hex')}`
  const initialCapability = `opaque-initial-${randomBytes(32).toString('base64url')}`
  const renewedCapability = `opaque-renewed-${randomBytes(32).toString('base64url')}`
  const authorized = new Map([[initialCapability, canary]])
  const egressCalls: Array<{ capability: string; method: string; path: string; headers: Array<[string, string]>; bodyBase64: string }> = []
  const providerCalls: Array<{ authorization: string | undefined; body: string }> = []
  const fixtureErrors: unknown[] = []
  let origin = ''
  const http = createServer((request, response) => {
    void (async () => {
      if (request.url === '/provider/v1/widgets') {
        providerCalls.push({ authorization: request.headers.authorization, body: (await body(request)).toString('utf8') })
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'protected-child-result' }))
        return
      }
      if (request.url !== '/invoke') { response.writeHead(404); response.end(); return }
      const message = JSON.parse((await body(request)).toString('utf8')) as typeof egressCalls[number]
      egressCalls.push(message)
      const secret = authorized.get(message.capability)
      if (!secret) { response.writeHead(401); response.end(); return }
      const upstream = await fetch(`${origin}/provider${message.path}`, {
        method: message.method,
        headers: { ...Object.fromEntries(message.headers), authorization: `Bearer ${secret}` },
        body: Buffer.from(message.bodyBase64, 'base64').toString('utf8'),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: upstream.status, headers: { 'content-type': 'application/json' },
        bodyBase64: Buffer.from(await upstream.arrayBuffer()).toString('base64') }))
    })().catch(error => { fixtureErrors.push(error); response.destroy() })
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => { http.off('error', reject); resolve() })
  })
  cleanups.push(async () => {
    http.closeAllConnections()
    await new Promise<void>(resolve => http.close(() => resolve()))
  })
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Expected the HTTP fixture TCP address')
  origin = `http://127.0.0.1:${address.port}`
  const access = taskSecretAccessSchema.parse({ version: 1, endpoint: `${origin}/invoke`, unavailable: [], grants: [{
    name: 'SERVICE_API_KEY', capability: initialCapability, origin: 'https://third-party.invalid',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  }] })
  expect(JSON.stringify(access).includes(canary)).toBe(false)

  const nativeModel = 'synthetic-selected-model-credential'
  const nativeGit = 'synthetic-authorized-github-credential'
  for (const [name, value] of Object.entries({
    ANTHROPIC_API_KEY: nativeModel, OPENAI_API_KEY: nativeModel,
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-native-subscription', GH_TOKEN: nativeGit, GITHUB_TOKEN: nativeGit,
  })) vi.stubEnv(name, value)
  const parentEnv = { ...process.env }
  const root = tempDir('task-secret-child-')
  const repo = { repoId: 'repo', name: 'SDK fixture', path: await makeRepo() }
  const server = new MemoryServer('device')
  server.addRepo('device', repo)
  const runId = server.queueRun('device', { issueId: 'issue', repoId: repo.repoId, baseBranch: 'main', harness: 'mock',
    prompt: 'Exercise the protected third-party SDK.', taskSecrets: access,
    modelCredential: { kind: 'api_key', key: nativeModel },
    github: { endpoint: 'https://mikka.invalid/api/runs/github-token', repository: 'owner/repo', token: nativeGit, expiresAt: null },
  })
  const link = server.link()
  const assignment = await link.claimRun('device', runId)
  server.online = false
  const log = createLogger({ level: 'silent' })
  const file = join(root, 'runs.json')
  const journal = new RunJournal(file)
  const outboxDir = join(root, 'outbox')
  const outbox = new Outbox(outboxDir, link, log, 60_000)
  const firstChild = deferred<ChildCapture>()
  const continueRun = deferred<void>()
  const captures: ChildCapture[] = []
  const starts: StartOptions[] = []
  const start = async (options: StartOptions): Promise<AgentSession> => {
    starts.push(options)
    try {
      const first = await sdkChild(options)
      captures.push(first)
      firstChild.resolve(first)
      await continueRun.promise
      captures.push(await sdkChild(options))
      return { sessionId: 'real-sdk-child',
        async *events() { yield { type: 'exit', outcome: 'succeeded', report: { summary: 'Protected child SDK accepted.' } } },
        async send() {}, async cancel() {},
      }
    } catch (error) { firstChild.reject(error); throw error }
  }
  const adapter: AgentAdapter = { harness: 'mock', capabilities: { supportsResume: false, supportsInterject: false },
    envAllow: [], start, async resume() { throw new Error('A fresh SDK fixture must not resume') },
  }
  const supervisor = new RunSupervisor({ journal, outbox, log, adapterStateDir: join(root, 'adapters'),
    worktrees: new WorktreeManager(join(root, 'worktrees')), adapters: new Map([['mock', adapter]]),
    repository: () => repo, prepareRepository: async () => {}, baseRef: async () => 'main',
  })
  cleanups.push(async () => { continueRun.resolve(); await supervisor.stop(); await outbox.close() })
  supervisor.start(assignment)
  await Promise.race([firstChild.promise, supervisor.idle().then(() => { throw new Error('Run ended before the SDK child reported its environment') })])
  const beforeRenewal = readFileSync(file, 'utf8')
  expect(supervisor.heartbeatRuns().find(run => run.runId === runId)?.secretCapabilities).toEqual([initialCapability])
  const renewed = taskSecretAccessSchema.parse({ ...access, grants: [{ ...access.grants[0], capability: renewedCapability,
    expiresAt: new Date(Date.now() + 600_000).toISOString() }] })
  authorized.delete(initialCapability)
  authorized.set(renewedCapability, canary)
  supervisor.renewTaskSecrets({ [runId]: renewed })
  expect(supervisor.heartbeatRuns().find(run => run.runId === runId)?.secretCapabilities).toEqual([renewedCapability])
  continueRun.resolve()
  await supervisor.idle()
  await outbox.close()

  // This fixture ends a native turn; it does not invent a submit handoff.
  expect(journal.get(runId)?.state).toBe('stopped')
  expect(journal.get(runId)?.stopReason).toBe('turn_ended')
  expect(captures).toHaveLength(2)
  for (const capture of captures) {
    expect(capture.status).toBe(201)
    expect(JSON.parse(capture.body)).toEqual({ id: 'protected-child-result' })
    expect(capture.env.SDK_KEY).toBe('mikka-protected')
    expect(capture.env.MIKKA_SECRET_ENDPOINTS).toBe(starts[0].taskSecretEnv?.MIKKA_SECRET_ENDPOINTS)
    expect(Object.keys(capture.env).filter(name => /SECRET|(?:TOKEN|API_KEY)$/.test(name))).toEqual(['MIKKA_SECRET_ENDPOINTS'])
    for (const hidden of [canary, initialCapability, renewedCapability, nativeModel, nativeGit])
      expect(JSON.stringify(capture).includes(hidden), 'The SDK child received a hidden credential').toBe(false)
  }
  expect(egressCalls.map(call => call.capability)).toEqual([initialCapability, renewedCapability])
  expect(providerCalls).toEqual(Array.from({ length: 2 }, () => ({ authorization: `Bearer ${canary}`, body: '{"source":"real-node-child"}' })))
  expect(starts[0].credential).toEqual({ kind: 'api_key', key: nativeModel })
  expect(starts[0].github?.token).toBe(nativeGit)
  const persisted = beforeRenewal + readFileSync(file, 'utf8') + readFileSync(join(outboxDir, `${runId}.jsonl`), 'utf8')
  for (const hidden of [canary, initialCapability, renewedCapability, nativeModel, nativeGit])
    expect(persisted.includes(hidden), 'A credential was written to the journal or outbox').toBe(false)
  const restored = new RunJournal(file).get(runId)!
  expect(restored.taskSecretsWithheld).toBe(true)
  expect(restored.assignment.taskSecrets).toBeUndefined()
  expect(restored.assignment.modelCredential).toBeUndefined()
  expect(restored.assignment.github?.token).toBeUndefined()
  expect(Object.keys(process.env).sort()).toEqual(Object.keys(parentEnv).sort())
  for (const name of Object.keys(parentEnv)) expect(process.env[name] === parentEnv[name], `Parent environment changed: ${name}`).toBe(true)
  expect(fixtureErrors).toEqual([])
})

it('aborting during listen leaves no server handle keeping a real child alive', async () => {
  const script = `
import { startTaskSecretBridge } from './src/task-secret-bridge.ts';
const controller = new AbortController();
const access = { version: 1, endpoint: 'http://127.0.0.1:1/invoke', unavailable: [], grants: [{
  name: 'SERVICE_API_KEY', capability: 'opaque-abort-fixture', origin: 'https://third-party.invalid',
  expiresAt: new Date(Date.now() + 300000).toISOString(),
}] };
const starting = startTaskSecretBridge({ current: () => access, signal: controller.signal });
controller.abort();
try { const bridge = await starting; bridge?.close(); throw new Error('Unexpected successful start'); }
catch (error) { if (!controller.signal.aborted || error.message === 'Unexpected successful start') throw error; }
process.stdout.write('aborted-without-open-listener');
`
  const result = await execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: {}, encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024,
  })
  expect(result.stdout).toBe('aborted-without-open-listener')
})

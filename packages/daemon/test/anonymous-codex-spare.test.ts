import { afterEach, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { policySnapshotHash } from '@mikka/protocol/node-policy-snapshot'
import type { AnonymousCodexHint } from '@mikka/protocol/codex-startup'
import { startAnonymousCodex } from '../src/anonymous-codex-spare'
import { buildChildEnv } from '../src/env'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
function fixture(mode = 'normal', diagnostics = false) {
  const root = mkdtempSync(join(tmpdir(), 'anonymous-codex-')), home = join(root, 'home'), stateDir = join(home, '.mikka', 'worker', 'adapters')
  mkdirSync(home); cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const trace = join(root, 'protocol.jsonl'), binary = join(root, 'codex')
  const fake = `const fs=require('node:fs'),rl=require('node:readline');
rl.createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({method:frame.method})+'\\n');
 if(frame.method==='fixture/exit_with_descendant'){
  const owned=require('node:child_process').spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:['ignore','inherit','inherit']});
  owned.once('spawn',()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{started:true}})+'\\n',()=>process.exit(0)));return;
 }
 if(frame.method==='initialize'&&process.env.FIXTURE_MODE==='hang')return;
 if(frame.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{userAgent:'mikka/'+(process.env.FIXTURE_MODE==='version'?'0.163.0':'0.166.0')+' (Linux)'}})+'\\n');
});`
  writeFileSync(binary, '#!' + process.execPath + '\n' + fake, { mode: 0o755 })
  const runId = randomUUID(), policy = defaultRunPolicy()
  const hint: AnonymousCodexHint = { version: 1, profile: 'cloud_repository_codex_0166_v1', runId,
    bootstrapSha256: createHash('sha256').update('owned-bootstrap').digest('hex'), model: 'gpt-fixture', effort: 'high',
    kind: 'implement', github: false, diagnostics, policy, mailboxTools: [], decisionCatalogue: {
      version: 1, tool: { name: 'record_decision', title: 'Record', description: 'Test decision', inputSchema: { type: 'object' }, annotations: { idempotentHint: true } },
    } }
  const bootstrap = { sha256: hint.bootstrapSha256, deviceId: randomUUID(), workspaceId: randomUUID() }
  const env = { HOME: home, PATH: process.env.PATH!, FIXTURE_TRACE: trace, FIXTURE_MODE: mode }, lifetime = new AbortController()
  const candidate = startAnonymousCodex({ hint, bootstrap, stateDir, binary, env, signal: lifetime.signal, initializeTimeoutMs: 1000 })!
  cleanups.push(candidate.close)
  const cwd = join(home, '.mikka', 'repos', 'future-repo')
  const fresh = { runId, deviceId: bootstrap.deviceId, workspaceId: bootstrap.workspaceId, model: hint.model, effort: hint.effort,
    policyHash: policySnapshotHash(policy), diagnostics, decisionCatalogue: hint.decisionCatalogue }
  const binding = async () => {
    const timing = diagnostics ? await candidate.takeTiming(fresh) : undefined
    if (timing) cleanups.push(() => timing.close({ publish: false, cliExitObserved: candidate.nativeExitObserved }))
    const finalEnv = { ...env, ...buildChildEnv({ host: env, adapterAllow: [], runId }), ...(diagnostics ? { CLOUD_STARTUP_TIMING: '1' } : {}),
      MIKKA_POLICY_HASH: policySnapshotHash(policy), CODEX_HOME: join(home, '.codex'),
      PATH: dirname(binary) + delimiter + env.PATH, ...timing?.env }
    return { fresh, binary, cwd, env: finalEnv, mcp: { command: process.execPath,
      args: [fileURLToPath(new URL('../src/agents/mikka-mcp.mjs', import.meta.url)), '--handoff', join(stateDir, 'runs', runId, 'handoff.json')], env: {} },
      assertLive: () => lifetime.signal.throwIfAborted(), onRevoke: (fn: () => void) => {
        lifetime.signal.addEventListener('abort', fn, { once: true }); return () => lifetime.signal.removeEventListener('abort', fn)
      } }
  }
  return { root, home, hint, candidate, lifetime, binding, cwd,
    checkout() { mkdirSync(join(cwd, '.git'), { recursive: true }) },
    events() { return existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).method) : [] } }
}
it('sends only initialize before a repository exists, then adopts that exact process once', async () => {
  const f = fixture(); await f.candidate.ready
  expect(existsSync(f.cwd)).toBe(false); expect(f.events().filter(x => x === 'initialize')).toHaveLength(1); expect(f.events().every(x => ['initialize', 'initialized'].includes(x))).toBe(true)
  f.checkout()
  const adopted = await f.candidate.adopt(await f.binding())
  expect(adopted).toBeDefined(); expect(f.candidate.state).toBe('adopted')
  expect(f.candidate.preparationTiming).toBeUndefined()
  expect(f.events().filter(x => x === 'initialize')).toHaveLength(1); expect(f.events().every(x => ['initialize', 'initialized'].includes(x))).toBe(true)
  await expect(f.candidate.adopt(await f.binding())).rejects.toThrow('consumed')
  expect(f.candidate.state).toBe('closed')
})
it.each(['project', 'environment', 'identity'])('drains %s mismatch before any login or task frame', async kind => {
  const f = fixture(); await f.candidate.ready; f.checkout()
  const binding = await f.binding()
  if (kind === 'project') mkdirSync(join(f.cwd, '.codex'))
  if (kind === 'environment') binding.env.PATH += ':changed'
  if (kind === 'identity') binding.fresh.deviceId = randomUUID()
  expect(await f.candidate.adopt(binding)).toBeUndefined()
  expect(f.candidate.state).toBe('closed'); expect(f.candidate.nativeExitObserved).toBe(true)
  expect(f.events().filter(x => x === 'initialize')).toHaveLength(1); expect(f.events().every(x => ['initialize', 'initialized'].includes(x))).toBe(true)
})
it('keeps revoked authority a failure, including while waiting for initialization', async () => {
  const f = fixture(); await f.candidate.ready; f.checkout(); f.lifetime.abort()
  await expect(f.candidate.adopt(await f.binding())).rejects.toThrow()
  await f.candidate.close(); expect(f.candidate.nativeExitObserved).toBe(true)
})
it('cancels a pending initialize and drains without waiting for a login', async () => {
  const f = fixture('hang'); f.lifetime.abort()
  await f.candidate.close(); await expect(f.candidate.ready).rejects.toThrow()
  expect(f.candidate.state).toBe('closed')
})
it('does not adopt a different native protocol version', async () => {
  const f = fixture('version'); await expect(f.candidate.ready).rejects.toThrow('version')
  await f.candidate.close(); expect(f.candidate.state).toBe('closed')
})
it('retains the true earlier timing origin only for successful adoption', async () => {
  const f = fixture('normal', true); await f.candidate.ready; const earlier = Date.now(); f.checkout()
  await f.candidate.adopt(await f.binding())
  const receipt = f.candidate.preparationTiming!
  expect(receipt.source).toBe('bootstrap_codex_initialize'); expect(receipt.harness).toBe('codex')
  expect(receipt.startedAt).toBeLessThanOrEqual(earlier); expect(receipt.outcome).toBe('ok')
  expect(receipt.phases.filter(x => x.outcome === 'ok').map(x => x.name)).toContain('daemon.adapter.cli_init')
  expect(receipt.phases.map(x => x.name)).toContain('daemon.adapter.cli_init.prewarm')
})

it('reaps owned descendants on leader exit before waiting for inherited pipes to close', async () => {
  const f = fixture(); await f.candidate.ready; f.checkout()
  const adopted = (await f.candidate.adopt(await f.binding()))!
  const leaderExited = new Promise<void>(resolve => adopted.child.process.once('exit', () => resolve()))
  await adopted.rpc.sendRequest('fixture/exit_with_descendant')
  await leaderExited
  let timer: NodeJS.Timeout | undefined
  try {
    const closed = await Promise.race([adopted.child.exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000) })])
    expect(closed).toBe(true)
    expect(f.candidate.nativeExitObserved).toBe(true)
  } finally { clearTimeout(timer); await f.candidate.close() }
})

it.each(['project', 'environment', 'identity'] as const)('does not publish bootstrap adoption timing after initialized candidate %s rejection', async kind => {
  const f = fixture('normal', true); await f.candidate.ready; f.checkout()
  expect(f.candidate.preparationTiming).toBeUndefined()
  const binding = await f.binding()
  if (kind === 'project') mkdirSync(join(f.cwd, '.codex'))
  if (kind === 'environment') binding.env.PATH += ':changed'
  if (kind === 'identity') binding.fresh.deviceId = randomUUID()
  expect(await f.candidate.adopt(binding)).toBeUndefined()
  expect(f.candidate.preparationTiming).toBeUndefined()
  expect(f.candidate.state).toBe('closed'); expect(f.candidate.nativeExitObserved).toBe(true)
  expect(f.events().filter(method => method === 'initialize')).toHaveLength(1)
  expect(f.events().every(method => ['initialize', 'initialized'].includes(method))).toBe(true)
})

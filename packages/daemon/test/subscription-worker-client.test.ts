import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SubscriptionWorkerClient } from '../src/subscription-worker-client'
import { SubscriptionCallTiming, withSubscriptionTiming } from '../src/subscription-worker-timing'
import { cleanupTempDirs, tempDir } from './helpers'

afterEach(cleanupTempDirs)
function fixture(hold = false, resolveIdentity?: (executionOnly: boolean, signal?: AbortSignal) => Promise<{ workloadToken?: string; accessToken?: string; accessSnapshot?: {name: string; value: string} }>, accessProject?: string, snapshotMode = false, prepareFailure?: string, streamFailure?: unknown, streamIdentity?: ConstructorParameters<typeof SubscriptionWorkerClient>[3]) {
  const directory = tempDir('mikka-worker-boundary-')
  const journal = join(directory, 'calls')
  const binary = join(directory, 'worker.mjs')
  writeFileSync(journal, '')
  writeFileSync(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
let config;const lines=createInterface({input:process.stdin});lines.on('line',line=>{const value=JSON.parse(line);if(!config){config=value;return};const request=value;appendFileSync(${JSON.stringify(journal)},request.method+'\\n');
const result={fullAuthority:Boolean(config.workloadToken||config.path),sourceAuthority:Boolean(config.enrollmentAttemptPath||config.enrollmentClaimPath||config.enrollmentGrantPath),accessAuthority:config.accessToken==='fixture-access-reader',snapshot:config.accessSnapshot?.name,binding:config.use?.bindingId,consumer:config.use?.consumerId,accessProject:config.accessProject};
if(request.method==='prepare'||request.method==='prepareStream'){setTimeout(()=>{console.log(JSON.stringify({id:request.id,...(${JSON.stringify(prepareFailure)} ? {error:${JSON.stringify(prepareFailure)}} : {result:{ready:true}})}));lines.close()},${hold ? 500 : 0});return}
if(request.method==='nativeStream'){console.log(JSON.stringify({id:request.id,head:{contentType:'application/json'}}));for(const byte of Buffer.from(JSON.stringify({...result,text:'汉字🙂'})))console.log(JSON.stringify({id:request.id,binaryChunk:Buffer.from([byte]).toString('base64')}));console.log(JSON.stringify({id:request.id,result:{done:true}}));lines.close();return}
if(request.method==='executeStream'&&${JSON.stringify(Boolean(streamFailure))}){console.log(JSON.stringify({id:request.id,error:'provider_request_rejected',providerFailure:${JSON.stringify(streamFailure ?? null)}}));lines.close();return}
if(request.method==='executeStream'){console.log(JSON.stringify({id:request.id,chunk:JSON.stringify(result)}));console.log(JSON.stringify({id:request.id,result:{done:true}}))}else console.log(JSON.stringify({id:request.id,result}));lines.close()})
`)
  chmodSync(binary, 0o700)
  const client = new SubscriptionWorkerClient({ binary }, {
    scope: { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', connectionId: '20000000-0000-4000-8000-000000000001', provider: 'codex' },
    databaseUrl: 'synthetic', infisicalOrigin: 'https://fixture.invalid', project: 'fixture', environment: 'test', path: '/grants', workloadToken: 'fixture-custody-identity', accessPath: '/access', accessProject, accessToken: snapshotMode ? undefined : 'fixture-access-reader', enableRuntime: true, enrollmentAttemptPath: '/attempts', enrollmentClaimPath: '/claims', enrollmentGrantPath: '/pending'
  }, resolveIdentity, streamIdentity).forUse({ bindingId: '20000000-0000-4000-8000-000000000002', consumerId: 'fixture-task' })
  return { client, journal }
}
it('quota and inference children receive no full-bundle identity and retain the exact task binding', async () => {
  const { client } = fixture()
  expect(await client.call('quota', { revision: 2 })).toEqual({ fullAuthority: false, sourceAuthority: false, accessAuthority: true, binding: '20000000-0000-4000-8000-000000000002', consumer: 'fixture-task' })
  let text = ''
  for await (const chunk of client.stream(2, 'fixture-model', {})) text += new TextDecoder().decode(chunk)
  expect(JSON.parse(text)).toMatchObject({ fullAuthority: false, sourceAuthority: false, accessAuthority: true, consumer: 'fixture-task' })
})
it('cancelling during preparation cannot start inference afterward', async () => {
  const { client, journal } = fixture(true)
  const reader = client.stream(2, 'fixture-model', {}).getReader()
  await new Promise(resolve => setTimeout(resolve, 100))
  await reader.cancel()
  await new Promise(resolve => setTimeout(resolve, 650))
  expect(readFileSync(journal, 'utf8')).not.toContain('executeStream')
})
it('keeps a fixed preparation refusal visible to the caller without starting inference', async () => {
  const { client, journal } = fixture(false, undefined, undefined, false, 'reconnect_required')
  const reader = client.stream(2, 'fixture-model', {}).getReader()
  await expect(reader.read()).rejects.toMatchObject({ name: 'WorkerRefusal', code: 'reconnect_required' })
  expect(readFileSync(journal, 'utf8')).not.toContain('executeStream')
  reader.releaseLock()
})
it('preserves a redacted provider diagnosis across real worker IPC without changing the refusal code', async () => {
  const { client } = fixture(false, undefined, undefined, false, undefined, { provider: 'codex', status: 400, error: { type: 'invalid_request_error', message: 'Unsupported field. [redacted]' } })
  const reader = client.stream(2, 'fixture-model', { messages: [{ role: 'user', content: 'A private request fixture.' }] }).getReader()
  const failure = await reader.read().then(() => { throw new Error('expected_failure') }, error => error)
  expect(failure).toMatchObject({ name: 'WorkerRefusal', code: 'provider_request_rejected', failureDetails: { category: 'invalid_request', status: 400, provider: 'codex' } })
  expect(failure.failureDetails.providerMessage).toContain('Unsupported field.')
  expect(JSON.stringify(failure.failureDetails)).not.toContain('A private request fixture.')
  reader.releaseLock()
})
it('ignores malformed worker diagnostics while preserving the original refusal', async () => {
  const { client } = fixture(false, undefined, undefined, false, undefined, { provider: 'claude', status: 400, error: { type: 'invalid_request_error', message: 'wrong provider' } })
  const reader = client.stream(2, 'fixture-model', {}).getReader()
  const failure = await reader.read().then(() => { throw new Error('expected_failure') }, error => error)
  expect(failure.code).toBe('provider_request_rejected')
  expect(failure.failureDetails).toBeUndefined()
  reader.releaseLock()
})
it('native broker requests retain the task and access-reader boundary and preserve split UTF-8 bytes', async () => {
  const { client } = fixture()
  const response = await client.nativeRequest(2, {path:'/responses',headers:{},body:{model:'fixture-model'}})
  expect(response.contentType).toBe('application/json')
  expect(await new Response(response.body).json()).toMatchObject({fullAuthority:false,sourceAuthority:false,accessAuthority:true,consumer:'fixture-task',text:'汉字🙂'})
  expect(await client.call('nativeContext', {revision:2})).toMatchObject({fullAuthority:false,sourceAuthority:false,accessAuthority:true})
})

it('custody retains source cleanup paths without exposing them to execution children', async () => {
  const { client } = fixture()
  expect(await client.call('status')).toMatchObject({ fullAuthority: true, sourceAuthority: true })
})

it('resolves only the identity required for each worker and strips custody from execution', async () => {
  const calls: boolean[] = []
  const { client } = fixture(false, async executionOnly => {
    calls.push(executionOnly)
    return executionOnly ? { workloadToken: 'must-not-cross-boundary', accessToken: 'fixture-access-reader' } : { workloadToken: 'fixture-custody-identity' }
  })
  expect(await client.call('status')).toMatchObject({ fullAuthority: true, sourceAuthority: true })
  expect(await client.call('quota')).toMatchObject({ fullAuthority: false, sourceAuthority: false, accessAuthority: true })
  expect(calls).toEqual([false, true])
})

it('passes the dedicated access project to custody and restricted execution workers', async () => {
  const { client } = fixture(false, undefined, 'isolated-access-project')
  expect(await client.call('status')).toMatchObject({ fullAuthority: true, accessProject: 'isolated-access-project' })
  expect(await client.call('quota')).toMatchObject({ fullAuthority: false, accessProject: 'isolated-access-project' })
})

it('passes only the selected access snapshot to an execution child when an identity is shared', async () => {
  const name = 'mikka-byos-00000000-0000-4000-8000-000000000001'
  const { client } = fixture(false, async executionOnly => executionOnly ? { accessSnapshot: { name, value: 'projection' } } : { workloadToken: 'fixture-custody-identity' }, undefined, true)
  expect(await client.call('quota', { revision: 2 })).toMatchObject({ fullAuthority: false, sourceAuthority: false, accessAuthority: false, snapshot: name })
})

it('does not start a worker request if identity resolution fails or is cancelled', async () => {
  const { client, journal } = fixture(false, async () => { throw new Error('secret must not leak') })
  await expect(client.call('status')).rejects.toThrow('subscription_worker_unavailable')
  expect(readFileSync(journal, 'utf8')).toBe('')
  const aborted = new AbortController()
  aborted.abort()
  await expect(client.call('status', {}, aborted.signal)).rejects.toThrow('subscription_cancelled')
})

it('logs only the worker\'s fixed-shape store failure line from stderr', async () => {
  const directory = tempDir('mikka-worker-stderr-')
  const binary = join(directory, 'worker.mjs')
  writeFileSync(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline'
let config;createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);if(!config){config=value;return}
console.error('secret_store_failure POST http_403');console.error('raw provider body token=secret');setTimeout(()=>console.log(JSON.stringify({id:value.id,error:'secret_store_unavailable'})),50)})
`)
  chmodSync(binary, 0o700)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const client = new SubscriptionWorkerClient({ binary }, { scope: { ownerId: 'o', workspaceId: 'w', connectionId: '20000000-0000-4000-8000-000000000001', provider: 'codex' }, databaseUrl: 'synthetic', infisicalOrigin: 'https://fixture.invalid', project: 'fixture', environment: 'test', path: '/grants', workloadToken: 'w' } as never)
    await expect(client.call('oauthStart', { revision: 1 })).rejects.toThrow('secret_store_unavailable')
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([JSON.stringify({ level: 'warn', msg: 'subscription_worker', detail: 'secret_store_failure POST http_403' })])
  } finally { warn.mockRestore() }
})

it('accepts only fixed request-boundary diagnostics and preserves the refusal if logging throws', async () => {
  const directory = tempDir('mikka-worker-request-stderr-')
  const binary = join(directory, 'worker.mjs')
  const allowed = [
    'subscription_request_failure claude input payload_too_large 262145 262144',
    'subscription_request_failure claude input payload_too_large 1048577 1048576',
    'subscription_request_failure codex conversion payload_too_large 524289 524288',
    'subscription_request_failure codex conversion payload_too_large 2097153 2097152',
    'subscription_request_failure claude conversion json_invalid 37 524288',
    'subscription_request_failure unknown stream stream_unavailable 0 0',
    'subscription_request_failure claude stream chunk_too_large 65537 65536',
  ]
  const denied = [
    'raw provider body fixture-private-token',
    'subscription_request_failure fixture-private-provider input json_invalid 1 262144',
    'subscription_request_failure claude input fixture_private_token 1 262144',
    'subscription_request_failure claude stream json_invalid 1 262144',
    'subscription_request_failure claude input payload_too_large -1 262144',
    'subscription_request_failure claude input payload_too_large 1.5 262144',
    'subscription_request_failure claude input payload_too_large 10000000000 262144',
    'subscription_request_failure claude input payload_too_large 262145 999999',
    'subscription_request_failure claude input payload_too_large 2097153 2097152',
    'subscription_request_failure codex conversion payload_too_large 1048577 1048576',
    'subscription_request_failure claude stream chunk_too_large 1048577 1048576',
    'subscription_request_failure claude input payload_too_large 262145 262144 fixture-private-body',
  ]
  writeFileSync(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline'
let config;createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);if(!config){config=value;return}
for(const line of ${JSON.stringify([...allowed, ...denied])}) console.error(line)
setTimeout(()=>console.log(JSON.stringify({id:value.id,error:'provider_operation_failed'})),50)})
`)
  chmodSync(binary, 0o700)
  for (const loggingThrows of [false, true]) {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { if (loggingThrows) throw new Error('fixture-private-log-failure') })
    try {
      const client = new SubscriptionWorkerClient({ binary }, { scope: { ownerId: 'o', workspaceId: 'w', connectionId: '20000000-0000-4000-8000-000000000001', provider: 'codex' }, databaseUrl: 'synthetic', infisicalOrigin: 'https://fixture.invalid', project: 'fixture', environment: 'test', path: '/grants', workloadToken: 'w' } as never)
      await expect(client.call('oauthStart', { revision: 1 })).rejects.toMatchObject({ name: 'WorkerRefusal', code: 'provider_operation_failed' })
      expect(warn.mock.calls.map(call => JSON.parse(String(call[0])).detail)).toEqual(allowed)
      expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture-private')
    } finally { warn.mockRestore() }
  }
})

const projectedScope = { ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', connectionId: '20000000-0000-4000-8000-000000000001', provider: 'codex' }
const freshProjection = (changes: Record<string, unknown> = {}) => ({ name: 'mikka-byos-00000000-0000-4000-8000-000000000001', value: JSON.stringify({
  schema: 1, ...projectedScope, payload: { type: 'codex', access_token: 'fixture-access', account_id: 'fixture-account', expired: new Date(Date.now() + 3_600_000).toISOString() }, ...changes,
}) })
it('a fresh same-call parent snapshot skips custody preparation and resolves the projection once', async () => {
  const projected = freshProjection()
  let reads = 0
  const ordinary = vi.fn(async () => ({ workloadToken: 'fixture-custody-identity' }))
  const { client, journal } = fixture(false, ordinary, undefined, true, undefined, undefined, async () => { reads++; return { accessSnapshot: projected } })
  const result = await new Response(client.stream(2, 'fixture-model', {})).json()
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual(['executeStream'])
  expect(reads).toBe(1)
  expect(ordinary).not.toHaveBeenCalled()
  expect(result).toMatchObject({ fullAuthority: false, sourceAuthority: false, accessAuthority: false, snapshot: projected.name, binding: '20000000-0000-4000-8000-000000000002', consumer: 'fixture-task' })
})


it.each(['missing', 'expiring'] as const)('uses the original custody path for an authorized %s projection, then reads a new snapshot', async reason => {
  const stale = freshProjection()
  const payload = JSON.parse(stale.value)
  payload.payload.expired = new Date(Date.now() + 30_000).toISOString()
  stale.value = JSON.stringify(payload)
  const fresh = freshProjection()
  fresh.name = 'mikka-byos-00000000-0000-4000-8000-000000000002'
  const calls: boolean[] = []
  const preRead = vi.fn(async () => reason === 'missing' ? null : { accessSnapshot: stale })
  const { client, journal } = fixture(false, async execution => {
    calls.push(execution)
    return execution ? { accessSnapshot: fresh } : { workloadToken: 'fixture-custody-identity' }
  }, undefined, true, undefined, undefined, preRead)
  expect(await new Response(client.stream(2, 'fixture-model', {})).json()).toMatchObject({ snapshot: fresh.name, fullAuthority: false, accessAuthority: false })
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual(['prepareStream', 'executeStream'])
  expect(preRead).toHaveBeenCalledTimes(1)
  expect(calls).toEqual([false, true])
})

it('a denied or malformed pre-read cannot turn into custody preparation', async () => {
  const wrongOwner = freshProjection({ ownerId: 'other-owner' })
  for (const resolution of [
    async () => { throw new Error('subscription_access_unavailable') },
    async () => { throw new TypeError('private network cause') },
    async () => ({ accessSnapshot: { ...freshProjection(), value: 'private malformed JSON' } }),
    async () => ({ accessSnapshot: wrongOwner }),
  ]) {
    const ordinary = vi.fn(async () => ({ workloadToken: 'fixture-custody-identity' }))
    const { client, journal } = fixture(false, ordinary, undefined, true, undefined, undefined, resolution)
    await expect(new Response(client.stream(2, 'fixture-model', {})).text()).rejects.toMatchObject({ code: 'subscription_worker_unavailable' })
    expect(readFileSync(journal, 'utf8')).toBe('')
    expect(ordinary).not.toHaveBeenCalled()
  }
})

it('Stop while a pre-read is pending ends the read; a late snapshot cannot start a child', async () => {
  const pending = Promise.withResolvers<{ accessSnapshot: { name: string; value: string } }>()
  const entered = Promise.withResolvers<void>()
  const { client, journal } = fixture(false, undefined, undefined, true, undefined, undefined, async () => { entered.resolve(); return pending.promise })
  const abort = new AbortController()
  const read = new Response(client.stream(2, 'fixture-model', {}, abort.signal)).text()
  const failure = expect(read).rejects.toMatchObject({ code: 'subscription_cancelled' })
  await entered.promise
  abort.abort()
  await failure
  pending.resolve({ accessSnapshot: freshProjection() })
  await new Promise(resolve => setImmediate(resolve))
  expect(readFileSync(journal, 'utf8')).toBe('')
})

it('a pre-read that ignores cancellation is bounded by the original 35s preparation deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = Promise.withResolvers<{ accessSnapshot: { name: string; value: string } }>()
    const { client, journal } = fixture(false, undefined, undefined, true, undefined, undefined, () => pending.promise)
    const read = new Response(client.stream(2, 'fixture-model', {})).text()
    const failure = expect(read).rejects.toMatchObject({ code: 'subscription_timeout' })
    await vi.advanceTimersByTimeAsync(35_000)
    await failure
    pending.resolve({ accessSnapshot: freshProjection() })
    await Promise.resolve()
    expect(readFileSync(journal, 'utf8')).toBe('')
  } finally { vi.useRealTimers() }
})

it('cold custody receives only the time left in the original preparation budget', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const pending = Promise.withResolvers<null>()
    const custodyStarted = Promise.withResolvers<void>()
    const custody = Promise.withResolvers<{ workloadToken: string }>()
    const ordinary = vi.fn(async (_execution: boolean) => { custodyStarted.resolve(); return custody.promise })
    const { client, journal } = fixture(false, ordinary, undefined, true, undefined, undefined, () => pending.promise)
    const timing = new SubscriptionCallTiming()
    const read = withSubscriptionTiming(timing, () => new Response(client.stream(2, 'fixture-model', {})).text())
    const failure = expect(read).rejects.toMatchObject({ code: 'subscription_timeout' })
    await vi.advanceTimersByTimeAsync(34_900)
    pending.resolve(null)
    await custodyStarted.promise
    await vi.advanceTimersByTimeAsync(100)
    await failure
    custody.resolve({ workloadToken: 'fixture-custody-identity' })
    await Promise.resolve()
    expect(ordinary).toHaveBeenCalledTimes(1)
    expect(ordinary.mock.calls[0][0]).toBe(false)
    expect(timing.snapshot().workers).toHaveLength(1)
    expect(timing.snapshot().workers[0]).toMatchObject({ method: 'prepareStream', outcome: 'error' })
    expect(readFileSync(journal, 'utf8')).toBe('')
  } finally { vi.useRealTimers() }
})

it('a warm provider refusal does not retry preparation or the provider', async () => {
  const ordinary = vi.fn(async () => ({ workloadToken: 'fixture-custody-identity' }))
  const { client, journal } = fixture(false, ordinary, undefined, true, undefined,
    { provider: 'codex', status: 429, error: { type: 'rate_limit_error' } },
    async () => ({ accessSnapshot: freshProjection() }))
  await expect(new Response(client.stream(2, 'fixture-model', {})).text()).rejects.toMatchObject({ code: 'provider_request_rejected' })
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual(['executeStream'])
  expect(ordinary).not.toHaveBeenCalled()
})

it('forUse and concurrent streams each read their own revision and snapshot exactly once', async () => {
  const seen: Array<{ revision: unknown; bindingId?: string; consumerId?: string }> = []
  const { client, journal } = fixture(false, undefined, undefined, true, undefined, undefined, async (_signal, use, revision) => {
    seen.push({ revision, bindingId: use?.bindingId, consumerId: use?.consumerId })
    const snapshot = freshProjection()
    snapshot.name = 'mikka-byos-00000000-0000-4000-8000-00000000000' + revision
    return { accessSnapshot: snapshot }
  })
  const other = client.forUse({ bindingId: 'other-binding', consumerId: 'other-consumer' })
  const [one, two] = await Promise.all([new Response(client.stream(2, 'fixture-model', {})).json(), new Response(other.stream(3, 'fixture-model', {})).json()])
  expect(seen).toEqual([
    { revision: 2, bindingId: '20000000-0000-4000-8000-000000000002', consumerId: 'fixture-task' },
    { revision: 3, bindingId: 'other-binding', consumerId: 'other-consumer' },
  ])
  expect(one).toMatchObject({ snapshot: 'mikka-byos-00000000-0000-4000-8000-000000000002', consumer: 'fixture-task' })
  expect(two).toMatchObject({ snapshot: 'mikka-byos-00000000-0000-4000-8000-000000000003', consumer: 'other-consumer' })
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual(['executeStream', 'executeStream'])
})

it('run-associated streams retain the original prepare path and never use the new hint', async () => {
  const preRead = vi.fn(async () => ({ accessSnapshot: freshProjection() }))
  const { client, journal } = fixture(false, undefined, undefined, false, undefined, undefined, preRead)
  const bound = client.forUse({ bindingId: 'run-binding', consumerId: 'run-consumer', runId: 'run-id' })
  await new Response(bound.stream(2, 'fixture-model', {})).json()
  expect(preRead).not.toHaveBeenCalled()
  expect(readFileSync(journal, 'utf8').trim().split('\n')).toEqual(['prepare', 'executeStream'])
})

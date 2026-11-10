import assert from 'node:assert/strict'
import test from 'node:test'
import { agentsByOffer, defaultOrder, deviceModel, dispatchOrder, latestDefaultCandidates, onPreferredAgent, pickDevice, placeStage, planDispatch, whyNoDevice, type CredentialState, type OrderEntry, type PoolDevice } from './model-order-plan'

// Model names here are fixtures standing for what a CLI or provider reported.
const sub = (id: string, harness: OrderEntry['harness'], model: string, connectionId = `conn-${harness}`): OrderEntry => ({ id, harness, model, source: { kind: 'subscription', connectionId } })

test('untouched defaults keep the newest release per account and family while retaining the full catalogue', () => {
  const models = ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-3-5-sonnet-20241022', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
  const catalogue = models.map((model, index) => ({ ...sub(String(index), model.startsWith('gpt-') ? 'codex' : 'claude_code', model), name: model }))
  assert.deepEqual(latestDefaultCandidates(catalogue).map(item => item.model), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna'])
  assert.deepEqual(catalogue.map(item => item.model), models, 'manual choices retain every release')
  const future = [...catalogue, { ...sub('future', 'claude_code', 'claude-opus-5-10'), name: 'new Opus' }]
  assert.deepEqual(latestDefaultCandidates(future).filter(item => item.model.includes('opus')).map(item => item.model), ['claude-opus-5-10'], 'versions compare numerically and replace old defaults')
  const otherAccount = { ...sub('other', 'claude_code', 'claude-opus-5', 'other-account'), name: 'other' }
  assert.ok(latestDefaultCandidates([...future, otherAccount]).includes(otherAccount), 'another account has its own catalogue')
  const unknown = { ...sub('unknown', 'claude_code', 'reported-new-family'), name: 'unknown' }
  assert.ok(latestDefaultCandidates([...future, unknown]).includes(unknown), 'unversioned or unfamiliar IDs are not guessed obsolete')
})

test('device readiness is independent of the credential model catalogue and CLI shortcuts', () => {
  const entry = sub('historical', 'claude_code', 'claude-sonnet-5', 'own-connection')
  const local = device('local', { harnesses: [{ harness: 'claude_code', installed: true, subscriptionBroker: true, models: ['opus', 'sonnet', 'haiku'] }] })
  assert.equal(deviceModel(local, entry), entry.model)
  assert.equal(placeStage(local, [entry], 'claude_code'), 'ready')
  assert.equal(deviceModel({ ...local, harnesses: [{ ...local.harnesses[0], subscriptionBroker: undefined }] }, entry), null)
  assert.equal(deviceModel({ ...local, harnesses: [{ ...local.harnesses[0], subscriptionPreflight: 'adapter_start_failed' }] }, entry), null)
  assert.equal(deviceModel({ ...local, online: false }, entry), null)
})

const key = (id: string, harness: OrderEntry['harness'], model: string): OrderEntry => ({ id, harness, model, source: { kind: 'api_key', keyId: 'key-1' } })
const device = (id: string, over: Partial<PoolDevice> = {}): PoolDevice => ({
  id, name: id, online: true, enabled: true, server: false, activeRuns: 0, joinedAt: 0,
  harnesses: [
    { harness: 'claude_code', installed: true, subscriptionBroker: true, modelSlots: [{ slot: 'top', model: 'reported-claude-top', name: 'Top' }] },
    { harness: 'codex', installed: true, subscriptionBroker: true, models: ['reported-codex-a'] },
  ],
  ...over,
})
const usable = (): CredentialState => ({ usable: true })
const first = sub('1', 'claude_code', 'reported-claude-top')
const second = sub('2', 'codex', 'reported-codex-a')
const keyed = key('3', 'claude_code', 'key-model')

test('an allowance check that failed keeps the subscription preference and does not silently charge a key', () => {
  const plan = planDispatch({ entries: [first, keyed], location: 'local', devices: [device('mac')], credential: entry => entry.id === first.id ? { usable: false, reason: 'checking' } : usable(), cloudReady: false })
  assert.equal(plan.kind, 'none')
  assert.equal(plan.kind === 'none' && plan.reason, 'checking')
  assert.deepEqual(plan.skipped.map(item => item.block.reason), ['checking'])
})

test('the first allowed model that can run takes the run; the full provider model is what runs despite a CLI slot', () => {
  const plan = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential: usable, cloudReady: false })
  assert.deepEqual([plan.kind, plan.kind === 'device' && plan.entry.id, plan.kind === 'device' && plan.model], ['device', '1', 'reported-claude-top'])
})

test('ordered fallback: quota used up, signed out, or no device moves to the next model, and says why each was skipped', () => {
  const credential = (entry: OrderEntry): CredentialState => entry.id === '1' ? { usable: false, reason: 'quota', resetsAt: '2026-11-02T14:20:00Z' } : usable()
  const plan = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential, cloudReady: false })
  assert.equal(plan.kind === 'device' && plan.entry.id, '2')
  assert.deepEqual(plan.skipped.map(item => [item.entry.id, item.block.reason]), [['1', 'quota']])
  const noClaude = planDispatch({ entries: [first, second], location: 'local', devices: [device('box', { harnesses: [{ harness: 'codex', installed: true, subscriptionBroker: true, models: ['reported-codex-a'] }] })], credential: usable, cloudReady: false })
  assert.deepEqual([noClaude.kind === 'device' && noClaude.entry.id, noClaude.skipped.map(item => item.block.reason)], ['2', ['noDevice']])
  const expired = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential: entry => entry.id === '2' ? usable() : { usable: false, reason: 'expired' }, cloudReady: false })
  assert.equal(expired.kind === 'device' && expired.entry.id, '2')
})

test('本地 picks only among the devices that can run it, never one with 参与调度 off, offline, or unable to take a subscription run', () => {
  const devices = [device('a'), device('off', { enabled: false }), device('down', { online: false }), device('b'),
    device('old', { harnesses: [{ harness: 'claude_code', installed: true, modelSlots: [{ slot: 'top', model: 'reported-claude-top', name: 'Top' }] }] })]
  const busy = devices.map(item => item.id === 'a' ? { ...item, activeRuns: 1 } : item)
  const plan = planDispatch({ entries: [first], location: 'local', devices: busy, credential: usable, cloudReady: false })
  assert.equal(plan.kind === 'device' && plan.deviceId, 'b', 'the idle one of the two that can run it')
  // Off, offline and old devices are never picked, however idle or server they are.
  const tempting = devices.map(item => item.id === 'a' || item.id === 'b' ? { ...item, activeRuns: 9 } : { ...item, server: true })
  const still = planDispatch({ entries: [first], location: 'local', devices: tempting, credential: usable, cloudReady: false })
  assert.equal(still.kind === 'device' && still.deviceId, 'a')
  assert.equal(deviceModel(device('off', { enabled: false }), first), null, '参与调度 off: never sent a run')
  assert.equal(deviceModel(device('x'), keyed), 'key-model', 'an API key model runs on any installed Agent of its protocol')
  assert.equal(deviceModel(device('x', { harnesses: [] }), keyed), null)
})

test('an admitted subscription model runs on any eligible broker without an exact CLI model report', () => {
  const silent = device('mac', { harnesses: [{ harness: 'claude_code', installed: true, subscriptionBroker: true }] })
  const opus = sub('9', 'claude_code', 'account-opus')
  assert.equal(deviceModel(silent, opus), opus.model)
  assert.equal(deviceModel(device('other'), opus), opus.model)
  const reporting = device('reporting', { joinedAt: 5 })
  const plan = planDispatch({ entries: [opus], location: 'local', devices: [silent, reporting], credential: usable, cloudReady: false })
  assert.deepEqual([plan.kind, plan.kind === 'device' && plan.deviceId, plan.kind === 'device' && plan.model], ['device', 'mac', 'account-opus'])
  const old = device('old', { harnesses: [{ harness: 'claude_code', installed: true }] })
  assert.equal(deviceModel(old, opus), null)
  assert.equal(deviceModel(old, keyed), 'key-model')
})

test('no computer can run it: the reason comes from the computer closest to running it', () => {
  const opus = sub('9', 'claude_code', 'account-opus')
  const old = (id: string) => device(id, { harnesses: [{ harness: 'claude_code', installed: true }] })
  const codexOnly = (id: string) => device(id, { harnesses: [{ harness: 'codex', installed: true, subscriptionBroker: true }] })
  assert.deepEqual(whyNoDevice([], opus), { why: 'none' })
  assert.deepEqual(whyNoDevice([device('mac', { enabled: false })], opus), { why: 'off', device: 'mac', count: 1 })
  assert.deepEqual(whyNoDevice([device('mac', { enabled: false }), device('box', { online: false })], opus), { why: 'offline', device: 'box', count: 1 })
  assert.deepEqual(whyNoDevice([device('box', { online: false }), codexOnly('mac')], opus), { why: 'notInstalled', device: 'mac', count: 1 })
  assert.deepEqual(whyNoDevice([codexOnly('mac'), old('MacBook Pro')], opus), { why: 'needsUpdate', device: 'MacBook Pro', count: 1 })
  assert.deepEqual(whyNoDevice([old('a'), old('b'), device('c', { enabled: false })], opus), { why: 'needsUpdate', device: 'a', count: 2 })
})

test('failed subscription preflight is actionable and overrides a stale broker flag without blocking API-key runs', () => {
  for (const detail of ['env_not_clean', 'cli_missing', 'cli_version_mismatch', 'adapter_start_failed'] as const) {
    const failed = device('checked computer', { harnesses: [{ harness: 'claude_code', installed: true, subscriptionBroker: true, subscriptionPreflight: detail, models: [first.model] }] })
    assert.equal(deviceModel(failed, first), null)
    assert.deepEqual(whyNoDevice([failed], first), { why: 'subscriptionRuntimeUnavailable', detail, device: 'checked computer', count: 1 })
    const plan = planDispatch({ entries: [first], location: 'local', devices: [failed], credential: usable, cloudReady: false })
    assert.equal(plan.kind, 'none')
    assert.equal(deviceModel(failed, keyed), keyed.model)
    assert.equal(deviceModel({ ...failed, harnesses: failed.harnesses.map(info => ({ ...info, subscriptionPreflight: undefined })) }, first), first.model)
  }
})

test('本地 order: a server before a computer, then the fewest unfinished runs, then the one that joined first; the same input gives the same device', () => {
  const mac = device('mac', { joinedAt: 1 })
  const server = device('server', { server: true, joinedAt: 5 })
  const plan = (devices: PoolDevice[]) => { const result = planDispatch({ entries: [first], location: 'local', devices, credential: usable, cloudReady: false }); return result.kind === 'device' ? result.deviceId : null }
  assert.equal(plan([mac, server]), 'server', 'a server first, though the computer joined earlier and is listed first')
  assert.equal(plan([mac, { ...server, activeRuns: 3 }]), 'server', 'a busy server still goes before an idle computer')
  assert.equal(plan([mac, { ...server, online: false }]), 'mac', 'no server that can run it: a computer')
  assert.equal(plan([mac, { ...server, enabled: false }]), 'mac', '参与调度 off: the computer')
  const second = device('server-2', { server: true, joinedAt: 9 })
  assert.equal(plan([second, server]), 'server', 'two idle servers: the one that joined first')
  assert.equal(plan([{ ...server, activeRuns: 2 }, { ...second, activeRuns: 1 }]), 'server-2', 'two servers: the one with fewer unfinished runs')
  assert.equal(plan([device('b'), device('a')]), 'a', 'a full tie: by id')
  for (let i = 0; i < 5; i++) assert.equal(plan([mac, second, server]), 'server', 'stable: no randomness')
  assert.equal(pickDevice([]), undefined)
})

test('a model the person picked for the thread goes first, before the list', () => {
  const plan = planDispatch({ entries: [first, second], explicit: second, location: 'local', devices: [device('mac')], credential: usable, cloudReady: false })
  assert.equal(plan.kind === 'device' && plan.entry.id, '2')
  const fallsBack = planDispatch({ entries: [first, second], explicit: second, location: 'local', devices: [device('mac')], credential: entry => entry.id === '2' ? { usable: false, reason: 'quota' } : usable(), cloudReady: false })
  assert.equal(fallsBack.kind === 'device' && fallsBack.entry.id, '1')
})

test('云端 runs the first usable model on the person\'s E2B machine', () => {
  const plan = planDispatch({ entries: [first, second], location: 'cloud', devices: [], credential: entry => entry.id === '1' ? { usable: false, reason: 'paused' } : usable(), cloudReady: true, cloudModel: () => 'ready' })
  assert.deepEqual([plan.kind, plan.kind === 'cloud' && plan.entry.id], ['cloud', '2'])
})

test('nothing can run: the card names why', () => {
  assert.equal(planDispatch({ entries: [], location: 'local', devices: [device('mac')], credential: usable, cloudReady: true, cloudModel: () => 'ready' }).kind === 'none' && 'noModels', 'noModels')
  const cloudOnly = planDispatch({ entries: [first], location: 'cloudOnly', devices: [device('mac')], credential: usable, cloudReady: false })
  assert.deepEqual([cloudOnly.kind, cloudOnly.kind === 'none' && cloudOnly.reason], ['none', 'cloudNotConfigured'])
  const cloud = planDispatch({ entries: [first], location: 'cloud', devices: [], credential: usable, cloudReady: false })
  assert.deepEqual([cloud.kind, cloud.kind === 'none' && cloud.reason], ['none', 'noDevice'])
  const local = planDispatch({ entries: [first, second], location: 'local', devices: [device('off', { enabled: false })], credential: usable, cloudReady: true, cloudModel: () => 'ready' })
  assert.deepEqual([local.kind, local.kind === 'none' && local.reason], ['none', 'noDevice'])
  const spent = planDispatch({ entries: [first, second], location: 'local', devices: [device('mac')], credential: () => ({ usable: false, reason: 'quota' }), cloudReady: true, cloudModel: () => 'ready' })
  assert.deepEqual([spent.kind, spent.kind === 'none' && spent.reason], ['none', 'unavailable'])
})

test('an untouched list: opus first, then the first Codex model reported, else the first model anything reported', () => {
  const sub = (connectionId: string) => ({ kind: 'subscription' as const, connectionId })
  const key = (keyId: string) => ({ kind: 'api_key' as const, keyId })
  const claude = [
    { harness: 'claude_code' as const, model: 'reported-sonnet-x', name: 'Sonnet X', source: sub('c') },
    { harness: 'claude_code' as const, model: 'reported-opus-x', name: 'Opus X', source: sub('c') },
  ]
  const chatgpt = [
    { harness: 'codex' as const, model: 'reported-codex-top', name: 'reported-codex-top', source: sub('g') },
    { harness: 'codex' as const, model: 'reported-codex-next', name: 'reported-codex-next', source: sub('g') },
  ]
  const deepseek = [
    { harness: 'claude_code' as const, model: 'reported-deepseek-chat', name: 'reported-deepseek-chat', source: key('d') },
    { harness: 'claude_code' as const, model: 'reported-deepseek-reasoner', name: 'reported-deepseek-reasoner', source: key('d') },
  ]
  const models = (items: Parameters<typeof defaultOrder>[0]) => defaultOrder(items).map(item => item.model)
  assert.deepEqual(models(chatgpt), ['reported-codex-top'], 'only ChatGPT: its Codex model, no tier word needed')
  assert.deepEqual(models([...claude, ...chatgpt]), ['reported-opus-x', 'reported-codex-top'], 'Claude and ChatGPT: opus, then Codex')
  assert.deepEqual(models(deepseek), ['reported-deepseek-chat'], 'only a DeepSeek key: its first model')
  assert.deepEqual(models(claude), ['reported-opus-x'], 'no Codex: opus only')
  assert.deepEqual(models([...claude, ...deepseek]), ['reported-opus-x'], 'opus placed: other keys stay out')
  // A key that runs Claude Code and reports opus counts; a subscription's opus wins over it.
  const keyOpus = { harness: 'claude_code' as const, model: 'key-opus', name: 'key-opus', source: key('k') }
  assert.deepEqual(models([keyOpus]), ['key-opus'])
  assert.deepEqual(models([keyOpus, ...claude]), ['reported-opus-x'])
  // An OpenAI-compatible key reports Codex models too.
  assert.deepEqual(models([{ harness: 'codex' as const, model: 'key-codex', name: 'key-codex', source: key('o') }]), ['key-codex'])
  assert.deepEqual(models([]), [], 'nothing connected: nothing')
  // A DeepSeek key serves both Agents: alone, its first model on Claude Code; beside ChatGPT, ChatGPT's Codex model still comes second.
  const both = deepseek.flatMap(item => [item, { ...item, harness: 'codex' as const }])
  assert.deepEqual(defaultOrder(both).map(item => [item.model, item.harness]), [['reported-deepseek-chat', 'claude_code']])
  assert.deepEqual(defaultOrder([...claude, ...chatgpt, ...both]).map(item => [item.model, item.harness]), [['reported-opus-x', 'claude_code'], ['reported-codex-top', 'codex']])
  // 优先使用的 Agent Codex: the same DeepSeek model lands on Codex instead.
  assert.deepEqual(defaultOrder(both, 'codex').map(item => [item.model, item.harness]), [['reported-deepseek-chat', 'codex']])
  assert.deepEqual(defaultOrder([...claude, ...both], 'codex').map(item => [item.model, item.harness]), [['reported-opus-x', 'claude_code'], ['reported-deepseek-chat', 'codex']])
  // Which Agents run each model and credential; one-Agent credentials are untouched by the preference.
  assert.deepEqual(agentsByOffer(both).get(`reported-deepseek-chat\u0000d`), ['claude_code', 'codex'])
  assert.deepEqual(onPreferredAgent([...claude, ...both], 'codex').map(item => item.harness), ['claude_code', 'claude_code', 'codex', 'codex'])
})

test('云端: the cloud, then a server, then a computer; a place is tried only when the one before it can run nothing', () => {
  const server = device('box', { server: true })
  const laptop = device('mac')
  const where = (plan: ReturnType<typeof planDispatch>) => plan.kind === 'device' ? plan.deviceId : plan.kind
  assert.equal(where(planDispatch({ entries: [first], location: 'cloud', devices: [laptop, server], credential: usable, cloudReady: true, cloudModel: () => 'ready' })), 'cloud')
  assert.equal(where(planDispatch({ entries: [first], location: 'cloud', devices: [laptop, server], credential: usable, cloudReady: false })), 'box')
  assert.equal(where(planDispatch({ entries: [first], location: 'cloud', devices: [laptop, device('box', { server: true, online: false })], credential: usable, cloudReady: false })), 'mac')
  // A computer always comes last: a later model on a server goes before an earlier one on a computer.
  const codexServer = device('box', { server: true, harnesses: [{ harness: 'codex', installed: true, subscriptionBroker: true, models: ['reported-codex-a'] }] })
  const later = planDispatch({ entries: [first, second], location: 'cloud', devices: [laptop, codexServer], credential: usable, cloudReady: false })
  assert.deepEqual([where(later), later.kind === 'device' && later.entry.id, later.skipped.map(item => [item.entry.id, item.block.reason])], ['box', '2', [['1', 'noDevice']]])
})

test('本地: a server, then a computer, never the cloud', () => {
  const plan = planDispatch({ entries: [first], location: 'local', devices: [device('mac'), device('box', { server: true })], credential: usable, cloudReady: true, cloudModel: () => 'ready' })
  assert.equal(plan.kind === 'device' && plan.deviceId, 'box')
  const none = planDispatch({ entries: [first], location: 'local', devices: [], credential: usable, cloudReady: true, cloudModel: () => 'ready' })
  assert.deepEqual([none.kind, none.kind === 'none' && none.reason], ['none', 'noDevice'])
})

test('a run the person put in the cloud goes nowhere else', () => {
  const plan = planDispatch({ entries: [first], location: 'cloudOnly', devices: [device('box', { server: true })], credential: usable, cloudReady: true, cloudModel: () => 'ready' })
  assert.equal(plan.kind, 'cloud')
})

test('a model whose allowance check failed stops the search in every place, unless one before it can run', () => {
  const checking = (entry: OrderEntry): CredentialState => entry.id === '2' ? { usable: false, reason: 'checking' } : usable()
  const stops = planDispatch({ entries: [first, second, keyed], location: 'cloud', devices: [device('box', { server: true, harnesses: [] })], credential: checking, cloudReady: false })
  assert.deepEqual([stops.kind, stops.kind === 'none' && stops.reason], ['none', 'checking'])
  const runs = planDispatch({ entries: [first, second, keyed], location: 'cloud', devices: [device('mac')], credential: checking, cloudReady: false })
  assert.equal(runs.kind === 'device' && runs.entry.id, '1')
})

test('a configured cloud without measured template models cannot take a subscription run', () => {
  const plan = planDispatch({ entries: [first], location: 'cloudOnly', devices: [], credential: usable, cloudReady: true })
  assert.equal(plan.kind, 'none')
  assert.equal(plan.kind === 'none' && plan.reason, 'cloudModelsUnknown')
})

test('dispatch order: the 优先使用的 Agent\'s list first, then the other\'s, each keeping its own order (decision 2026-11-05-0400)', () => {
  const rows = [{ id: 'codex-a', harness: 'codex' as const }, { id: 'claude-x', harness: 'claude_code' as const }, { id: 'codex-b', harness: 'codex' as const }, { id: 'claude-y', harness: 'claude_code' as const }]
  assert.deepEqual(dispatchOrder(rows, 'claude_code').map(row => row.id), ['claude-x', 'claude-y', 'codex-a', 'codex-b'])
  assert.deepEqual(dispatchOrder(rows, 'codex').map(row => row.id), ['codex-a', 'codex-b', 'claude-x', 'claude-y'])
  // One Agent only, or nothing: unchanged; the input is never reordered in place.
  assert.deepEqual(dispatchOrder(rows.filter(row => row.harness === 'codex'), 'claude_code').map(row => row.id), ['codex-a', 'codex-b'])
  assert.deepEqual(dispatchOrder([], 'codex'), [])
  assert.deepEqual(rows.map(row => row.id), ['codex-a', 'claude-x', 'codex-b', 'claude-y'])
})

test('a place in the 运行位置 chain says why it cannot take a run: 参与调度 off before offline before a missing Agent', () => {
  assert.equal(placeStage(device('mac', { enabled: false, online: false }), [first], 'claude_code'), 'off')
  assert.equal(placeStage(device('vm', { online: false }), [first], 'claude_code'), 'offline')
  assert.equal(placeStage(device('box', { harnesses: [] }), [first, second], 'claude_code'), 'notInstalled')
  assert.equal(placeStage(device('mac'), [first], 'claude_code'), 'ready')
  // With no runnable model it is judged on the preferred Agent alone.
  assert.equal(placeStage(device('mac'), [], 'claude_code'), 'ready')
  assert.equal(placeStage(device('box', { harnesses: [] }), [], 'claude_code'), 'notInstalled')
})

test('order view serializes supplied heartbeat times without changing its display snapshot', async t => {
  t.mock.module('./execution-settings.ts', { namedExports: { ExecutionSettings: class { async modelCandidates() { return [] } } } })
  t.mock.module('./personal-policy.ts', { namedExports: { pooledOwners: async () => [] } })
  t.mock.module('./subscription-runtime.ts', { namedExports: { authorizeSubscriptionWorkspace: async () => {} } })
  t.mock.module('./organization-connections-access.ts', { namedExports: { workspaceModelPolicy: async () => ({ sourceOrder: ['personal_subscription','personal_api_key','organization','shared_api_key'], models: {}, paidFallback: 'deny' }), organizationConnectionAuthority: async () => null } })
  t.mock.module('./model-api-keys.ts', { namedExports: { usableApiKeys: async () => [] } })
  t.mock.module('./model-provider-health.ts', { namedExports: { providerHealthStates: async () => new Map(), providerSourceKey: () => '' } })
  t.mock.module('./cloud-template-models.ts', { namedExports: { cloudModelSupport: () => 'unknown' } })
  t.mock.module('./device-presence.ts', { namedExports: { deviceOnlineStates: () => { throw new Error('unexpected device reread') } } })
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network read') })
  const { orderView } = await import('./model-order')
  const time = 1_800_000_000_000
  const future = 4_102_444_800_000
  const cases: { id: string; input: PoolDevice['lastSeenAt']; expected: number | null }[] = [
    { id: 'date', input: new Date(time), expected: time },
    { id: 'iso', input: new Date(time).toISOString(), expected: time },
    { id: 'number', input: time, expected: time },
    { id: 'zero', input: 0, expected: 0 },
    { id: 'future', input: future, expected: future },
    { id: 'null', input: null, expected: null },
    { id: 'missing', input: undefined, expected: null },
    { id: 'invalid-date', input: new Date(NaN), expected: null },
    { id: 'invalid-string', input: 'not-a-time', expected: null },
    { id: 'nan', input: NaN, expected: null },
    { id: 'infinity', input: Infinity, expected: null },
    { id: 'negative-infinity', input: -Infinity, expected: null },
  ]
  const devices = cases.map(row => Object.freeze(device(row.id, { lastSeenAt: row.input, online: false })))
  Object.freeze(devices)
  const queryKinds: string[] = []
  const query = { async query(sql: string) {
    if (sql.includes('FROM model_order_settings')) {
      queryKinds.push('settings')
      return { rows: [{ location: 'local', customized: false, preferredHarness: 'claude_code', autoModelRouting: true }] }
    }
    if (sql.includes('FROM byos_connections WHERE "ownerId"=$1 AND state=\'connected\'')) {
      queryKinds.push('connections')
      return { rows: [] }
    }
    throw new Error(`unexpected query: ${sql}`)
  } }
  let deviceReads = 0
  const view = await orderView(query as unknown as Parameters<typeof orderView>[0], { ownerId: 'owner-1', workspaceId: 'workspace-1' }, async () => { deviceReads++; return devices })
  assert.deepEqual(Object.fromEntries(view.places.devices.map(row => [row.id, row.lastSeenAt])), Object.fromEntries(cases.map(row => [row.id, row.expected])))
  assert.equal(deviceReads, 1, 'the projection reuses exactly one supplied device snapshot')
  assert.deepEqual(queryKinds, ['settings', 'connections'], 'timestamp serialization adds no database reads')
  assert.equal(view.dispatchOrder?.find(row => row.id === 'future')?.presenceReason, 'future_heartbeat')
  for (const [index, row] of devices.entries()) assert.ok(Object.is(row.lastSeenAt, cases[index].input), 'the scheduling input retains its original timestamp')
})

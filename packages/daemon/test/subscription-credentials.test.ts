import { afterEach, expect, it, vi } from 'vitest'
import type { NativeLease, RunAssignment } from '@mikka/protocol'
import { prepareSubscriptionCredentials } from '../src/subscription-credentials'

afterEach(() => vi.useRealTimers())
const lease = (expiry = Date.now() + 3_600_000): NativeLease => ({
  route: 'codex_cli', accountId: 'owner-account', revision: 2, modelId: 'fixture-model',
  accessToken: 'fixture-original-access', expiresAt: new Date(expiry).toISOString(),
})
const assignment = (value = lease()): RunAssignment => ({ runId: 'run', issueId: 'issue', deviceId: 'device', repoId: 'repo',
  harness: 'codex', model: 'fixture-model', prompt: 'work', subscriptionLease: value,
  subscriptionBinding: { bindingId: 'binding', ownerId: 'owner', workspaceId: 'workspace', consumerId: 'consumer', route: 'codex_cli' },
})

it('consumes the claim token without startup HTTP and serves all native callbacks from memory', async () => {
  const nativeLease = vi.fn(async () => { throw Error('unexpected network') })
  const credentials = await prepareSubscriptionCredentials(assignment(), { link: { nativeLease }, signal: new AbortController().signal })
  try {
    for (let i = 0; i < 100; i++) expect(credentials.current().accessToken).toBe('fixture-original-access')
    expect(nativeLease).not.toHaveBeenCalled()
  } finally { credentials.close() }
})

it('renews at natural expiry in the background while callbacks keep the valid token', async () => {
  vi.useFakeTimers()
  const original = lease(Date.now() + 120_000)
  let resolve!: (lease: NativeLease) => void
  const nativeLease = vi.fn(() => new Promise<NativeLease>(done => { resolve = done }))
  const onCredential = vi.fn()
  const credentials = await prepareSubscriptionCredentials(assignment(original), { link: { nativeLease }, signal: new AbortController().signal, onCredential })
  try {
    await vi.advanceTimersByTimeAsync(89_999)
    expect(nativeLease).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(nativeLease).toHaveBeenCalledOnce()
    expect(credentials.current().accessToken).toBe(original.accessToken)
    const renewed = { ...original, accessToken: 'fixture-rotated-access', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    resolve(renewed)
    await vi.advanceTimersByTimeAsync(0)
    expect(credentials.current()).toEqual(renewed)
    expect(onCredential).toHaveBeenLastCalledWith('SUBSCRIPTION_ACCESS_TOKEN', renewed.accessToken)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(nativeLease).toHaveBeenCalledOnce()
  } finally { credentials.close() }
})

it('does not poll if a lead-time refresh returns the same natural expiry', async () => {
  vi.useFakeTimers()
  const original = lease(Date.now() + 120_000)
  const nativeLease = vi.fn(async () => original)
  const credentials = await prepareSubscriptionCredentials(assignment(original), { link: { nativeLease }, signal: new AbortController().signal })
  try {
    await vi.advanceTimersByTimeAsync(119_999)
    expect(nativeLease).toHaveBeenCalledOnce()
    expect(credentials.current()).toEqual(original)
  } finally { credentials.close() }
})

it('enters the worker refresh window before requesting renewal instead of racing its 60 s boundary', async () => {
  vi.useFakeTimers()
  const original = lease(Date.now() + 120_000)
  const nativeLease = vi.fn(async () => Date.parse(original.expiresAt) - Date.now() < 60_000
    ? { ...original, accessToken: 'rotated-inside-worker-window', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
    : original)
  const credentials = await prepareSubscriptionCredentials(assignment(original), { link: { nativeLease }, signal: new AbortController().signal })
  try {
    await vi.advanceTimersByTimeAsync(60_000)
    expect(nativeLease).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(nativeLease).toHaveBeenCalledOnce()
    expect(credentials.current().accessToken).toBe('rotated-inside-worker-window')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(credentials.current().accessToken).toBe('rotated-inside-worker-window')
  } finally { credentials.close() }
})

it('does not switch account during renewal or publish an in-flight renewal after stop', async () => {
  vi.useFakeTimers()
  const original = lease(Date.now() + 120_000), controller = new AbortController(), onCredential = vi.fn()
  const nativeLease = vi.fn(async () => ({ ...original, accountId: 'another-account', accessToken: 'other-owner-token' }))
  const credentials = await prepareSubscriptionCredentials(assignment(original), { link: { nativeLease }, signal: controller.signal, onCredential })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(credentials.current()).toEqual(original)
  expect(onCredential).toHaveBeenCalledOnce()
  controller.abort()
  await vi.advanceTimersByTimeAsync(90_000)
  expect(nativeLease).toHaveBeenCalledOnce()
  expect(() => credentials.current()).toThrow('closed')
})

it.each(['route', 'modelId', 'expiresAt'] as const)('rejects a misbound initial %s before launching a CLI', async field => {
  const invalid = { ...lease(), [field]: field === 'route' ? 'claude_code_cli' : field === 'modelId' ? 'other-model' : new Date(0).toISOString() }
  await expect(prepareSubscriptionCredentials(assignment(invalid), { link: {}, signal: new AbortController().signal })).rejects.toThrow()
})

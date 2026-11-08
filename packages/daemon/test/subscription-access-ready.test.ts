import { expect, it } from 'vitest'
import { accessSnapshotReady } from '../src/subscription-access-ready'

const now = Date.UTC(2026, 10, 7)
const scope = { ownerId: 'owner', workspaceId: 'workspace', connectionId: 'connection', provider: 'codex' as const }
const iso = (remaining: number) => new Date(now + remaining).toISOString()
const jwt = (exp: number | string) => 'header.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.signature'
const projection = (payload: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => ({
  name: 'mikka-byos-00000000-0000-4000-8000-000000000001',
  value: JSON.stringify({ schema: 1, ...scope, payload: { type: 'codex', access_token: 'opaque', expired: iso(3_600_000), account_id: 'account', ...payload }, ...fields }),
})

it('keeps the existing strict one-minute boundary and never treats an unknown expiry as ready', () => {
  expect(accessSnapshotReady(scope, projection({ expired: iso(60_000) }), now)).toBe(false)
  expect(accessSnapshotReady(scope, projection({ expired: iso(60_001) }), now)).toBe(true)
  expect(accessSnapshotReady(scope, projection({ expired: iso(-1) }), now)).toBe(false)
  for (const expired of [undefined, null, 'unknown', 42]) {
    expect(() => accessSnapshotReady(scope, projection({ expired }), now)).toThrow('subscription_access_unavailable')
  }
})

it('uses the selected access-token JWT exp before buffered metadata, as pinned CPA does', () => {
  expect(accessSnapshotReady(scope, projection({ access_token: jwt((now + 30_000) / 1000) }), now)).toBe(false)
  expect(accessSnapshotReady(scope, projection({ access_token: jwt(String((now + 3_600_000) / 1000)), expired: iso(30_000) }), now)).toBe(true)
  expect(accessSnapshotReady(scope, projection({ access_token: jwt(now + 3_600_000), expired: iso(30_000) }), now)).toBe(true)
  expect(accessSnapshotReady(scope, projection({ access_token: 'not.a.valid.jwt' }), now)).toBe(true)
})

it('SIWC readiness follows its active token and real expiry instead of the outer credential', () => {
  expect(accessSnapshotReady(scope, projection({ use_siwc: true, siwc: { access_token: jwt((now + 30_000) / 1000), expired: iso(3_600_000) } }), now)).toBe(false)
  expect(accessSnapshotReady(scope, projection({ access_token: jwt((now - 30_000) / 1000), use_siwc: true, siwc: { access_token: jwt((now + 3_600_000) / 1000), expired: iso(30_000) } }), now)).toBe(true)
  expect(accessSnapshotReady(scope, projection({ use_siwc: true, siwc: { access_token: 'nested-opaque', expires_at: (now + 3_600_000) / 1000, expired: iso(30_000) } }), now)).toBe(true)
  expect(accessSnapshotReady(scope, projection({ use_siwc: true, siwc: { access_token: 'nested-opaque', expired: iso(30_000) } }), now)).toBe(false)
  for (const siwc of [undefined, {}, { access_token: 'nested-opaque' }]) {
    expect(() => accessSnapshotReady(scope, projection({ use_siwc: true, siwc }), now)).toThrow('subscription_access_unavailable')
  }
})

it('rejects scope mismatches and grant-bearing or malformed projections before any worker', () => {
  for (const field of ['ownerId', 'workspaceId', 'connectionId', 'provider']) {
    expect(() => accessSnapshotReady(scope, projection({}, { [field]: 'different' }), now)).toThrow('subscription_access_unavailable')
  }
  for (const payload of [
    { refresh_token: 'private-refresh' }, { id_token: 'private-id' },
    { siwc: { refresh_token: 'private-refresh' } }, { siwc: { id_token: 'private-id' } },
    { use_siwc: 'true' }, { account_id: '' }, { access_token: '' },
  ]) expect(() => accessSnapshotReady(scope, projection(payload), now)).toThrow('subscription_access_unavailable')
  expect(() => accessSnapshotReady(scope, { name: 'wrong', value: 'secret' }, now)).toThrow(/^subscription_access_unavailable$/)
})

it('supports the same Claude projection and does not mutate the supplied bytes', () => {
  const claude = { ...scope, provider: 'claude' as const }
  const value = Object.freeze(projection({ type: 'claude', account_uuid: 'account', organization_uuid: 'organization' }, { provider: 'claude' }))
  const before = value.value
  expect(accessSnapshotReady(claude, value, now)).toBe(true)
  expect(value.value).toBe(before)
})


it.each(['2099-01-01T00:00:00', '2099-02-30T00:00:00Z'])('rejects the unsupported SIWC date %s instead of trusting a later buffered date', invalidDate => {
  expect(() => accessSnapshotReady(scope, projection({ use_siwc: true, siwc: { access_token: 'nested-opaque', expires_at: invalidDate, expired: iso(3_600_000) } }), now)).toThrow('subscription_access_unavailable')
})
it('rejects an invalid outer calendar date that Go rejects as malformed credentials', () => {
  expect(() => accessSnapshotReady(scope, projection({ expired: '2099-02-30T00:00:00Z' }), now)).toThrow('subscription_access_unavailable')
})
it('ignores surplus JWT padding that pinned CPA would reject before refreshing', () => {
  let body = JSON.stringify({ exp: (now + 3_600_000) / 1000 })
  while (Buffer.byteLength(body) % 3 !== 0) body += ' '
  const extraPadding = 'header.' + Buffer.from(body).toString('base64url') + '==.signature'
  expect(accessSnapshotReady(scope, projection({ access_token: extraPadding, expired: iso(-1) }), now)).toBe(false)
})

it('a positive JWT expiry that truncates to zero cannot fall back to optimistic metadata', () => {
  expect(accessSnapshotReady(scope, projection({ access_token: jwt(0.5) }), now)).toBe(false)
})

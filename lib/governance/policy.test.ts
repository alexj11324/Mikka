import assert from 'node:assert/strict'
import test from 'node:test'
import { deploymentMode } from './edition'
import { csvCell, resolveEntitlements, seatAdmissionAllowed } from './policy'

test('governance follows the canonical deployment edition, independent of hosting and billing', () => {
  assert.equal(deploymentMode({}), 'selfhost')
  assert.equal(deploymentMode({ VERCEL_ENV: 'production' }), 'selfhost')
  assert.equal(deploymentMode({ VERCEL_ENV: 'preview' }), 'selfhost')
  assert.equal(deploymentMode({ VERCEL_ENV: 'production', MIKKA_EDITION: 'community', STRIPE_SECRET_KEY: 'configured' }), 'selfhost')
  assert.equal(deploymentMode({ MIKKA_EDITION: 'cloud' }), 'cloud')
  assert.equal(deploymentMode({ MIKKA_EDITION: ' cloud ' }), 'cloud')
  assert.equal(deploymentMode({ MIKKA_EDITION: '   ', VERCEL_ENV: 'production' }), 'selfhost')
  assert.throws(() => deploymentMode({ MIKKA_EDITION: 'other' }), /MIKKA_EDITION_INVALID/)
})

test('shared plans admit unlimited members and retain capacity limits', () => {
  const cloud = resolveEntitlements({ mode: 'cloud', kind: 'team' })
  const community = resolveEntitlements({ mode: 'selfhost', kind: 'team' })
  assert.equal(cloud.activeHumanLimit, null)
  assert.equal(cloud.approvalTemplates, false)
  assert.equal(cloud.hostedMaxInFlight, 8)
  assert.equal(community.activeHumanLimit, null)
  assert.equal(community.usageExport, true)
  assert.equal(seatAdmissionAllowed({ current: 5, limit: 5, alreadyActive: false }), false)
  assert.equal(seatAdmissionAllowed({ current: 5, limit: 5, alreadyActive: true }), true)
  assert.equal(seatAdmissionAllowed({ current: 999, limit: null, alreadyActive: false }), true)
})

test('paid grants have bounded expiry, deployment source and personal isolation', () => {
  const now = new Date('2026-11-07T00:00:00Z')
  const grant = { plan: 'pro' as const, source: 'cloud' as const, seatLimit: 20, expiresAt: new Date('2026-11-08T00:00:00Z') }
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant, now }).activeHumanLimit, null)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'personal', grant, now }).activeHumanLimit, 1)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant, now }).approvalTemplateLimit, 100)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant, now }).hostedMaxInFlight, 32)
  assert.equal(resolveEntitlements({ mode: 'selfhost', kind: 'team', grant, now }).edition, 'community')
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'personal', grant, now }).edition, 'personal')
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: { ...grant, expiresAt: now }, now }).edition, 'team_free')
  assert.equal(resolveEntitlements({ mode: 'selfhost', kind: 'team', grant: { ...grant, plan: 'enterprise', source: 'license' }, now }).edition, 'enterprise')
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: { ...grant, source: 'license' }, now }).edition, 'team_free')
})

test('downgrade changes capacity without refusing member admission', () => {
  const free = resolveEntitlements({ mode: 'cloud', kind: 'team' })
  assert.equal(seatAdmissionAllowed({ current: 12000, limit: free.activeHumanLimit, alreadyActive: false }), true)
  assert.equal(free.hostedMaxInFlight, 8)
})

test('Stripe projection combines with operator grants, expires independently, and cannot grant self-hosted access', () => {
  const now = new Date('2026-11-10T00:00:00Z'), future = new Date('2026-12-10T00:00:00Z')
  const billing = { plan: 'free' as const, source: 'cloud' as const, seatLimit: null, expiresAt: null,
    billingPlan: 'pro' as const, billingExpiresAt: future }
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: billing, now }).hostedMaxInFlight, 32)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: { ...billing, billingExpiresAt: null }, now }).hostedMaxInFlight, 8)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grant: billing, now: future }).hostedMaxInFlight, 8)
  assert.equal(resolveEntitlements({ mode: 'selfhost', kind: 'team', grant: billing, now }).hostedMaxInFlight, 8)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'personal', grant: billing, now }).hostedMaxInFlight, 8)
  assert.equal(resolveEntitlements({ mode: 'cloud', kind: 'team', grants: [billing, { ...billing, plan: 'enterprise', billingPlan: 'free' }], now }).hostedMaxInFlight, 128)
})

test('CSV contains literal data, not spreadsheet formulas', () => {
  assert.equal(csvCell('hello,"world"'), '"hello,""world"""')
  for (const prefix of ['=', '+', '-', '@', ' \t=']) assert.equal(csvCell(`${prefix}SUM(A1:A2)`), `"'${prefix}SUM(A1:A2)"`)
  assert.equal(csvCell(123), '"123"')
  assert.equal(csvCell(null), '""')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { cloudflareRequest, runSummaries, vercelTotals } from './migration-usage.mjs'

test('FOCUS preserves shared charges, currencies, adjustments and provider day boundaries', async () => {
  const row = { ServiceName: 'Sandbox Active CPU', BillingCurrency: 'USD', ChargePeriodStart: '2026-11-09T08:00:00Z',
    ChargePeriodEnd: '2026-11-10T08:00:00Z', BilledCost: '2', EffectiveCost: '3', ConsumedUnit: 'hours', ConsumedQuantity: .5,
    SkuId: 'sku', SubAccountType: 'Project', SubAccountId: 'p1', Tags: { secret: 'never-emit-test-marker' } }
  const rows = [row, { ...row, BilledCost: '-1', EffectiveCost: '0', ChargeCategory: 'Adjustment' },
    { ...row, BillingCurrency: 'EUR', SubAccountType: 'Team', SubAccountId: null }]
  const result = await vercelTotals(rows.map(r => JSON.stringify(r)))
  assert.equal(result.records, 3)
  assert.equal(result.firstPeriodStart, '2026-11-09T08:00:00.000Z')
  assert.deepEqual(result.totalsByCurrency, [{ currency: 'USD', billed: 1, effective: 3 }, { currency: 'EUR', billed: 2, effective: 3 }])
  assert.equal(result.charges.length, 3)
  assert.doesNotMatch(JSON.stringify(result), /never-emit-test-marker/)
  await assert.rejects(vercelTotals([JSON.stringify({ ...row, BilledCost: null })]), /Invalid provider quantity/)
})

test('terminal receipts deduplicate and older receipts are distinct from missing provider samples', () => {
  const from = '2026-11-10T00:00:00Z', to = '2026-11-11T00:00:00Z', start = Date.parse(from)
  const job = { owner: '100/1/startup-timing', workload: 'startup-timing', issue: 1948, sha: 'a'.repeat(40) }
  const row = { repository: 'alexj11324/Mikka', provider: 'cloudflare', state: 'passed', requestedAt: start,
    settledAt: start + 500, stoppedAt: start + 700, job }
  const cancel = { state: 'cancelled', settledAt: start, stoppedAt: start + 10 }
  const other = { ...row, state: 'deadline', job: { ...job, owner: '101/1/startup-timing' }, providerInstanceId: 'b'.repeat(64), stoppedAt: start + 1500 }
  const report = runSummaries([row, row, other, cancel], from, to)
  assert.deepEqual(report.outcomes, { passed: 1, deadline: 1 })
  assert.equal(report.cancelledBeforeAdmission, 1)
  assert.equal(report.stopDelayP50Ms, 200)
  assert.equal(report.stopDelayP95Ms, 1000)
  assert.equal(report.runs[0].providerInstanceId, null)
  assert.throws(() => runSummaries([row, { ...row, stoppedAt: start + 900 }], from, to), /Conflicting/)
  const { query, variables } = cloudflareRequest('account', 'app', from, to, [other.providerInstanceId])
  assert.deepEqual(variables.usage, { applicationId: 'app', datetime_geq: from, datetime_lt: to, instanceId_in: [other.providerInstanceId] })
  assert.deepEqual(variables.usage, variables.metrics)
  assert.match(query, /dimensions \{ instanceId \}/)
})

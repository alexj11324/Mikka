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

test('same-team project tags, shared adjustments and multi-currency costs reconcile without leaking tags', async () => {
  const raw = { ServiceName:'Function CPU',SkuId:'cpu',BillingCurrency:'USD',ChargePeriodStart:'2026-11-10T08:00:00Z',
    ChargePeriodEnd:'2026-11-11T08:00:00Z',SubAccountId:'team_shared',SubAccountType:'Team',BilledCost:'1.01',EffectiveCost:'2.01' }
  const a = {...raw,Tags:{ProjectId:'prj_projectA',ProjectName:'private-name',Other:'never-publish'}}
  const b = {...raw,Tags:{ProjectId:'prj_projectB'},BilledCost:'0.02',EffectiveCost:'0.02'}
  const adjustment = {...raw,ServiceName:'Plan',BilledCost:'-0.50',EffectiveCost:'-0.50'}
  const invalid = {...raw,Tags:{ProjectId:'unstructured private tag'},BillingCurrency:'EUR'}
  const result=await vercelTotals([a,b,adjustment,invalid].map(row=>JSON.stringify(row)))
  assert.deepEqual(result.projects.map(row=>[row.currency,row.projectId,row.records,row.billed,row.effective]),[
    ['USD','prj_projectA',1,1.01,2.01],['USD','prj_projectB',1,.02,.02],['USD',null,1,-.5,-.5],['EUR',null,1,1.01,2.01],
  ])
  assert.equal(result.charges.find(row=>row.projectId==='prj_projectA').skuId,'cpu')
  assert.deepEqual(result.totalsByCurrency.map(row=>[row.currency,row.billed.toFixed(2),row.effective.toFixed(2)]),[['USD','0.53','1.53'],['EUR','1.01','2.01']])
  assert.doesNotMatch(JSON.stringify(result),/private-name|never-publish|unstructured private tag/)
})

const utc = (day, hour = 0) => new Date(Date.UTC(2026, 10, day, hour)).toISOString()
const period = (from, to) => ({ from, to })
const charge = (from, to, projectId = 'prj_projectA') => JSON.stringify({
  ServiceName: 'Compute', BillingCurrency: 'USD', BilledCost: 1, EffectiveCost: 1,
  ChargePeriodStart: from, ChargePeriodEnd: to, Tags: { ProjectId: projectId },
})

test('seven-day evidence retains internal gaps and both out-of-window tails across projects', async () => {
  const rows = [
    charge(utc(10), utc(12)), charge(utc(4), utc(5, 12), 'prj_projectB'), charge(utc(8), utc(9)),
    charge(utc(3), utc(5)), charge(utc(5, 12), utc(6)), charge(utc(13), utc(14)),
    charge(utc(3), utc(5), 'prj_projectB'),
  ]
  const result = await vercelTotals(rows, period(utc(4), utc(11)))
  assert.deepEqual(result.chargePeriodCoverage, {
    scope: 'returned-team-charge-records',
    observed: [period(utc(3), utc(6)), period(utc(8), utc(9)), period(utc(10), utc(12)), period(utc(13), utc(14))],
    unobservedInRequest: [period(utc(6), utc(8)), period(utc(9), utc(10))],
    observedOutsideRequest: [period(utc(3), utc(4)), period(utc(11), utc(12)), period(utc(13), utc(14))],
  })
  assert.equal(result.firstPeriodStart, utc(3))
  assert.equal(result.lastPeriodEnd, utc(14))
  assert.deepEqual(result.totalsByCurrency, [{ currency: 'USD', billed: 7, effective: 7 }])
  assert.deepEqual(result.projects.map(p => [p.projectId, p.records, p.billed]), [['prj_projectA', 5, 5], ['prj_projectB', 2, 2]])
})

test('provider reporting lag leaves the end of the requested UTC day unobserved', async () => {
  const result = await vercelTotals([charge(utc(10, 8), utc(11, 8))], period(utc(11), utc(12)))
  assert.deepEqual(result.chargePeriodCoverage, {
    scope: 'returned-team-charge-records', observed: [period(utc(10, 8), utc(11, 8))],
    unobservedInRequest: [period(utc(11, 8), utc(12))], observedOutsideRequest: [period(utc(10, 8), utc(11))],
  })
})

test('adjacent charge periods cover 48 hours and touching outer periods do not cover any part of the request', async () => {
  const window = period(utc(8), utc(10))
  const full = await vercelTotals([charge(utc(9), utc(10)), charge(utc(8), utc(9))], window)
  assert.deepEqual(full.chargePeriodCoverage.observed, [window])
  assert.deepEqual(full.chargePeriodCoverage.unobservedInRequest, [])
  assert.deepEqual(full.chargePeriodCoverage.observedOutsideRequest, [])
  const outside = await vercelTotals([charge(utc(7), utc(8)), charge(utc(10), utc(11))], window)
  assert.deepEqual(outside.chargePeriodCoverage.unobservedInRequest, [window])
  assert.deepEqual(outside.chargePeriodCoverage.observedOutsideRequest, [period(utc(7), utc(8)), period(utc(10), utc(11))])
})

test('empty and zero-duration rows cover no time and reversed charge periods reject the report', async () => {
  const window = period(utc(8), utc(10))
  const empty = await vercelTotals([], window)
  assert.equal(empty.records, 0)
  assert.equal(empty.firstPeriodStart, null)
  assert.equal(empty.lastPeriodEnd, null)
  assert.deepEqual(empty.chargePeriodCoverage, {
    scope: 'returned-team-charge-records', observed: [], unobservedInRequest: [window], observedOutsideRequest: [],
  })
  const point = await vercelTotals([charge(utc(9), utc(9))], window)
  assert.deepEqual(point.chargePeriodCoverage, empty.chargePeriodCoverage)
  assert.deepEqual(point.totalsByCurrency, [{ currency: 'USD', billed: 1, effective: 1 }])
  const noWindow = await vercelTotals([charge(utc(8), utc(10))])
  assert.deepEqual(noWindow.chargePeriodCoverage, {
    scope: 'returned-team-charge-records', observed: [window], unobservedInRequest: null, observedOutsideRequest: null,
  })
  await assert.rejects(vercelTotals([charge(utc(10), utc(8))], window), /Reversed provider charge period/)
  await assert.rejects(vercelTotals([], period(utc(10), utc(8))), /Invalid requested charge window/)
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

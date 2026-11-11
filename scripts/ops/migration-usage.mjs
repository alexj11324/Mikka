import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { TEAM } from './deployment-regression.mjs'

const iso = value => new Date(value).toISOString()
const decimal = value => {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || !Number.isFinite(Number(value))) {
    throw new Error('Invalid provider quantity')
  }
  return Number(value)
}

function day(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || iso(value).slice(0, 10) !== value) {
    throw new Error('Expected a UTC date YYYY-MM-DD')
  }
  return iso(value)
}

function token(name) {
  if (!process.env[name]) throw new Error('Missing environment variable ' + name)
  return process.env[name]
}

// The billing API returns FOCUS JSONL. The SubAccount field distinguishes a
// project from shared team usage. Never include Tags or customer resource IDs.
export async function vercelTotals(lines) {
  const groups = new Map()
  const totals = new Map()
  let records = 0, firstPeriodStart = null, lastPeriodEnd = null
  for await (const line of lines) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { throw new Error('Malformed provider billing record') }
    if (!row || typeof row.ServiceName !== 'string' || typeof row.BillingCurrency !== 'string' ||
        !Number.isFinite(Date.parse(row.ChargePeriodStart)) || !Number.isFinite(Date.parse(row.ChargePeriodEnd))) {
      throw new Error('Incomplete provider billing record')
    }
    const billed = decimal(row.BilledCost), effective = decimal(row.EffectiveCost)
    const currency = row.BillingCurrency
    const dimensions = { currency, subAccountType: row.SubAccountType ?? null, subAccountId: row.SubAccountId ?? null,
      service: row.ServiceName, skuId: row.SkuId ?? null, category: row.ChargeCategory ?? null, unit: row.ConsumedUnit ?? null }
    const key = JSON.stringify(dimensions)
    const group = groups.get(key) ?? { ...dimensions, records: 0, billed: 0, effective: 0, consumed: null }
    group.records++
    group.billed += billed
    group.effective += effective
    if (row.ConsumedQuantity != null) group.consumed = (group.consumed ?? 0) + decimal(row.ConsumedQuantity)
    groups.set(key, group)
    const total = totals.get(currency) ?? { currency, billed: 0, effective: 0 }
    total.billed += billed
    total.effective += effective
    totals.set(currency, total)
    const start = iso(row.ChargePeriodStart), end = iso(row.ChargePeriodEnd)
    if (!firstPeriodStart || start < firstPeriodStart) firstPeriodStart = start
    if (!lastPeriodEnd || end > lastPeriodEnd) lastPeriodEnd = end
    records++
  }
  return { records, firstPeriodStart, lastPeriodEnd, totalsByCurrency: [...totals.values()], charges: [...groups.values()] }
}

export function cloudflareRequest(account, applicationId, from, to, instances) {
  const grouped = Boolean(instances?.length)
  const dimensions = grouped ? 'dimensions { instanceId }' : ''
  const limit = grouped ? instances.length : 1
  const filter = { applicationId, datetime_geq: from, datetime_lt: to }
  if (grouped) filter.instanceId_in = instances
  return { query: 'query MigrationUsage($account:String!, $usage:AccountContainersUsageAdaptiveGroupsFilter_InputObject!, ' +
    '$metrics:AccountContainersMetricsAdaptiveGroupsFilter_InputObject!) { viewer { accounts(filter:{accountTag:$account}) { ' +
    'containersUsageAdaptiveGroups(limit:' + limit + ', filter:$usage) { ' + dimensions +
    ' sum { cpuTimeSec allocatedMemory allocatedDisk txBytes } } ' +
    'containersMetricsAdaptiveGroups(limit:' + limit + ', filter:$metrics) { ' + dimensions +
    ' count max { memory } sum { cpuTimeSec } } } } }', variables: { account, usage: filter, metrics: filter } }
}

async function cloudflare(applicationId, from, to, instances) {
  const account = token('CLOUDFLARE_ACCOUNT_ID')
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: { authorization: 'Bearer ' + token('CLOUDFLARE_API_TOKEN'), 'content-type': 'application/json' },
    body: JSON.stringify(cloudflareRequest(account, applicationId, from, to, instances)),
  })
  if (!response.ok) throw new Error('Cloudflare Analytics HTTP ' + response.status)
  const { data, errors } = await response.json()
  const accounts = data?.viewer?.accounts
  if (errors?.length || accounts?.length !== 1 || !Array.isArray(accounts[0].containersUsageAdaptiveGroups) ||
      !Array.isArray(accounts[0].containersMetricsAdaptiveGroups)) throw new Error('Cloudflare Analytics query failed')
  return accounts[0]
}

export function runSummaries(input, from, to) {
  const byRun = new Map()
  let cancelledBeforeAdmission = 0
  for (const row of input) {
    const { job, state, providerInstanceId, requestedAt, settledAt, stoppedAt } = row
    if (!job && state === 'cancelled' && Number.isSafeInteger(settledAt) && Number.isSafeInteger(stoppedAt) && stoppedAt >= settledAt) {
      if (settledAt >= Date.parse(from) && settledAt < Date.parse(to)) cancelledBeforeAdmission++
      continue
    }
    if (row.provider !== 'cloudflare' || row.repository !== 'alexj11324/Mikka' ||
        !/^\d+\/\d+\/[a-z][a-z0-9-]*$/.test(job?.owner) || !Number.isSafeInteger(job.issue) || job.issue < 1 ||
        !/^[a-z][a-z0-9-]*$/.test(job.workload) || !job.owner.endsWith('/' + job.workload) ||
        !/^[a-f\d]{40}$/.test(job.sha) || !['passed', 'failed', 'cancelled', 'deadline', 'interrupted'].includes(state) ||
        ![requestedAt, settledAt, stoppedAt].every(Number.isSafeInteger) || requestedAt > settledAt || settledAt > stoppedAt ||
        (providerInstanceId != null && !/^[a-f\d]{64}$/.test(providerInstanceId))) throw new Error('Invalid terminal engineering receipt')
    if (settledAt < Date.parse(from) || settledAt >= Date.parse(to)) continue
    const run = { owner: job.owner, issue: job.issue, workload: job.workload, source: job.sha, state,
      providerInstanceId: providerInstanceId ?? null, requestedAt, settledAt, stoppedAt, stopDelayMs: stoppedAt - settledAt }
    const prior = byRun.get(job.owner)
    if (prior && JSON.stringify(prior) !== JSON.stringify(run)) throw new Error('Conflicting receipts for one run')
    byRun.set(job.owner, run)
  }
  const runs = [...byRun.values()]
  const delays = runs.map(r => r.stopDelayMs).sort((a, b) => a - b)
  const quantile = p => delays[Math.ceil(delays.length * p) - 1] ?? null
  const outcomes = {}
  for (const run of runs) outcomes[run.state] = (outcomes[run.state] ?? 0) + 1
  return { samples: runs.length, cancelledBeforeAdmission, outcomes, stopDelayP50Ms: quantile(.5), stopDelayP95Ms: quantile(.95), runs }
}

async function main([provider, first, last, application, ...files]) {
  const from = day(first), to = day(last)
  if (from >= to) throw new Error('The exclusive end must be after the start')
  if (provider === 'vercel' && !application) {
    const url = new URL('https://api.vercel.com/v1/billing/charges')
    url.search = new URLSearchParams({ teamId: TEAM, from, to })
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { authorization: 'Bearer ' + token('VERCEL_TEAM_TOKEN') } })
    if (!response.ok) throw new Error('Vercel FOCUS HTTP ' + response.status)
    const lines = createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity })
    return { provider, from, to, ...await vercelTotals(lines) }
  }
  if (provider !== 'cloudflare' || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/.test(application)) {
    throw new Error('Expected vercel FROM TO or cloudflare FROM TO APPLICATION_ID [RECEIPT.json ...]')
  }
  const applicationId = application.replaceAll('-', '').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')
  const receipts = await Promise.all(files.map(async p => JSON.parse(await readFile(p, 'utf8'))))
  const summary = runSummaries(receipts, from, to)
  const overall = await cloudflare(applicationId, from, to)
  const ids = [...new Set(summary.runs.map(r => r.providerInstanceId).filter(Boolean))]
  const usage = new Map(), workload = new Map()
  for (let i = 0; i < ids.length; i += 50) {
    const result = await cloudflare(applicationId, from, to, ids.slice(i, i + 50))
    for (const row of result.containersUsageAdaptiveGroups) usage.set(row.dimensions.instanceId, row.sum)
    for (const row of result.containersMetricsAdaptiveGroups) workload.set(row.dimensions.instanceId, { samples: row.count, peakMemoryBytes: row.max.memory, cpuTimeSec: row.sum.cpuTimeSec })
  }
  return { provider, from, to, applicationId, metered: overall.containersUsageAdaptiveGroups[0]?.sum ?? null,
    workloadSamples: overall.containersMetricsAdaptiveGroups[0] ?? null,
    ...summary, runs: summary.runs.map(r => ({ ...r, metered: usage.get(r.providerInstanceId) ?? null, workloadMetrics: workload.get(r.providerInstanceId) ?? null })) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}

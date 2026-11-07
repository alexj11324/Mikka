#!/usr/bin/env node
// The 「Mikka 数据库与错误」 dashboard, its insights and the five database/error
// alerts as code (docs/operations/tracing.md, "Dashboard and alerts").
// Idempotent: finds each object by its production id, else its `key:` tag, else
// its exact name; creates what is missing and updates only what differs.
//
//   node scripts/ops/posthog-observability.mjs            # read-only plan (default)
//   node scripts/ops/posthog-observability.mjs --check    # exit 1 when production differs
//   node scripts/ops/posthog-observability.mjs --apply    # create or update
//
// POSTHOG_PERSONAL_API_KEY (phx_…, scopes insight/dashboard/alert read+write) comes
// from the environment, e.g. `infisical run --env=prod --path=/platform -- node …`.
// It is never printed. POSTHOG_HOST and POSTHOG_PROJECT_ID default to production.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const here = new URL('./posthog/', import.meta.url)
const sql = name => readFileSync(new URL(`${name}.sql`, here), 'utf8')

export const MANAGED_TAG = 'managed:mikka-db-errors'
const MONITORING_DASHBOARD = 'https://us.posthog.com/project/670821/dashboard/2297143'

const hogql = (query, { dateFrom, display, chartSettings } = {}) => ({
  kind: 'DataVisualizationNode',
  source: { kind: 'HogQLQuery', query, ...(dateFrom ? { filters: { dateRange: { date_from: dateFrom, explicitDate: false, excludeIncompletePeriods: false } } } : {}) },
  ...(display ? { display } : {}),
  ...(chartSettings ? { chartSettings } : {}),
})

const hourlyChart = (column, label, formatting) => ({
  xAxis: { column: 'hour_utc' },
  yAxis: [{ column, settings: { display: { label }, formatting } }],
  showLegend: true, xAxisLabel: '小时（UTC）', showNullsAsZero: false,
  leftYAxisSettings: { label, startAtZero: true }, seriesBreakdownColumn: 'route',
})
const queriesChart = hourlyChart('estimated_queries_weighted', '估算查询数（按采样率加权）', { style: 'number', decimalPlaces: 0 })
const bytesChart = hourlyChart('estimated_json_bytes_weighted', '估算 JSON 字节（按采样率加权）', { style: 'short', suffix: ' B', decimalPlaces: 1 })
const single = { chartSettings: { showNullsAsZero: false } }

/** Every insight, in dashboard order. `shortId` is the production object; `tile` is its dashboard layout. */
export const INSIGHTS = [
  { key: 'daily-budget', shortId: 'CpCslHvh', name: 'Mikka daily transfer budget', tags: ['database-egress', 'operations'], tile: { h: 3, w: 6, x: 0, y: 6 },
    description: 'Latest known supplier value within 30 days; may be stale. Check monitoring heartbeat for collection health. No samples return NULL, never an assumed zero.',
    query: hogql(sql('daily-budget'), single) },
  { key: 'monthly-budget', shortId: 'Vy1tVOwr', name: 'Mikka billing-period transfer budget', tags: ['database-egress', 'operations'], tile: { h: 3, w: 6, x: 6, y: 6 },
    description: 'Latest known supplier value within 30 days; may be stale. Check monitoring heartbeat for collection health. No samples return NULL, never an assumed zero.',
    query: hogql(sql('monthly-budget'), single) },
  { key: 'coverage-7d', shortId: 'nQaTfq8D', name: '7d 数据覆盖与缺失属性 · 采样原数 / 加权估算', tags: ['issue-1324', 'tracing'], tile: { h: 4, w: 12, x: 0, y: 9 },
    description: 'UTC 首末 span、实际覆盖小时及缺失属性。sampled_* 为收到的条数；estimated_*_weighted 按每条 sample_rate 加权，历史缺失按 0.1。缺失小时不补零；仅 production。',
    query: hogql(sql('coverage'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  { key: 'route-queries-24h', shortId: 'kFw6Ai83', name: '24h 每小时数据库查询 · route Top 15 · 按采样率加权', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 6, x: 0, y: 13 },
    description: '按窗口加权查询数选 Top 15；保留 sampled_queries 原数。权重为每条 span 的 1/sample_rate，历史缺失按 0.1。UTC，无数据小时不补零。',
    query: hogql(sql('route-queries'), { dateFrom: '-24h', display: 'ActionsLineGraph', chartSettings: queriesChart }) },
  { key: 'route-queries-7d', shortId: 'E31K4pde', name: '7d 每小时数据库查询 · route Top 15 · 按采样率加权', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 6, x: 6, y: 13 },
    description: '默认 7d 窗口；采集自 2026-11-05 02:38 UTC。Top 15 按加权查询数；每条 1/sample_rate，历史缺失按 0.1。历史不足不补零。',
    query: hogql(sql('route-queries'), { dateFrom: '-7d', display: 'ActionsLineGraph', chartSettings: queriesChart }) },
  { key: 'route-bytes-24h', shortId: 'iSpRMGJo', name: '24h 每小时返回 JSON 近似字节 · route Top 15 · 按采样率加权', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 6, x: 0, y: 19 },
    description: '返回行 JSON 近似字节按每条 1/sample_rate 加权，历史缺失按 0.1。非 Neon 传输或账单；Top 15 按加权字节；缺失不当零。',
    query: hogql(sql('route-bytes'), { dateFrom: '-24h', display: 'ActionsLineGraph', chartSettings: bytesChart }) },
  { key: 'route-bytes-7d', shortId: '7F8ewK9A', name: '7d 每小时返回 JSON 近似字节 · route Top 15 · 按采样率加权', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 6, x: 6, y: 19 },
    description: '默认 7d；JSON 近似字节按每条 1/sample_rate 加权，历史缺失按 0.1。非 Neon 账单；缺失小时不补零，缺字节查询单列。',
    query: hogql(sql('route-bytes'), { dateFrom: '-7d', display: 'ActionsLineGraph', chartSettings: bytesChart }) },
  { key: 'client-kinds-7d', shortId: 'gAICaKyP', name: '7d 来源数据库查询与 JSON 近似字节 · 采样原数 / 加权估算', tags: ['issue-1324', 'tracing'], tile: { h: 5, w: 12, x: 0, y: 25 },
    description: 'production 的 web、daemon、mobile、cron、worker、background、workflow 归因。每条 1/sample_rate 加权，历史缺失按 0.1；保留收到的原数。',
    query: hogql(sql('client-kinds'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  { key: 'statements-7d', shortId: 'zBWWQsSI', name: '7d 大返回 SQL Top 20 · statement ID · 采样原数 / 加权估算', tags: ['issue-1324', 'tracing'], tile: { h: 8, w: 12, x: 0, y: 30 },
    description: '按加权 JSON 近似字节降序；每条 1/sample_rate，历史缺失按 0.1。参数化 SQL ≤200 字符；缺字节单列；非 Neon 账单。',
    query: hogql(sql('statements'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  { key: 'error-causes-7d', shortId: 'yKovH9bi', name: '7d 错误原因 Top 100 · code / detail · 采样原数 / 加权估算', tags: ['issue-1324', 'tracing'], tile: { h: 5, w: 12, x: 0, y: 38 },
    description: '按代码/类型汇总错误 spans；实际条数与按 1/sample_rate 加权估算并列，历史缺失按 0.1。未知 code/detail 标明；不是去重失败请求。',
    query: hogql(sql('error-causes'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  { key: 'errors-7d', shortId: 'y3Vykg2b', name: '7d 错误路由 Top 100 · route / code / detail · 采样原数 / 加权估算', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 12, x: 0, y: 43 },
    description: 'status_code=2；code 回退 error.type。按 1/sample_rate 加权，历史缺失按 0.1；保留实际条数。一次失败可有多个 spans。',
    query: hogql(sql('errors'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  // Alert-only insights: not on this dashboard (the heartbeat sits on the monitoring dashboard).
  { key: 'heartbeat', shortId: 'r8wuvlUx', name: 'Mikka monitoring heartbeat', tags: ['database-egress', 'operations'],
    description: 'Latest snapshot within one hour must be healthy and contain supplier hour/day fields. Missing or failed collection returns unhealthy.',
    query: hogql(sql('heartbeat'), single) },
  { key: 'alert-source-anomaly', shortId: 'k3M88Rs8', name: '[1324] Mikka 来源数据库小时异常', tags: ['mikka', 'issue-1324', 'observability', 'source-alerts'],
    description: 'Weighted DB queries/JSON bytes > max(3×7d median,2,000 queries/10MB). Weight=1/sample_rate; legacy missing=0.1. Warmup 24 covered full hours after each route first appears; bytes require ≥95% weighted coverage. Alert includes top authenticated user hashes / registered RPC actions and unattributed counts; same-request enrichment only. No current telemetry→NULL.',
    query: hogql(sql('alert-source-anomaly'), { display: 'ActionsTable' }) },
  { key: 'alert-daily-pace', shortId: 'E08gP1zi', name: '[1324] Mikka 日速率外推超过500GB月额度', tags: ['mikka', 'issue-1324', 'observability', 'source-alerts'],
    description: 'UTC today bytes / elapsed hours through reported bucket ×24×month days vs 500GB. ≥3h; same UTC day; healthy snapshot≤60m/provider≤180m. Assumes complete provider day cumulative. Daily pace equivalent, not billing-period forecast; monthly 50% retained.',
    query: hogql(sql('alert-daily-pace'), { display: 'ActionsTable' }) },
  { key: 'alert-error-spike', shortId: 'STBizeTe', name: '[1324] Mikka 错误码小时突增', tags: ['mikka', 'issue-1324', 'observability', 'source-alerts'],
    description: 'Weighted errors >max(3×7d hourly median,50). Excludes closed Workflow 404/409/410 only with own successful wake/cron/step ancestry or invocation→2xx delivery (direct/one vqs.process parent or unique link). Missing proof stays counted. Weight=1/sample_rate (legacy 0.1); warmup 24 covered hours; zero-fill observed service hours only; no current telemetry→NULL. Spans≠failed requests.',
    query: hogql(sql('alert-error-spike'), { display: 'ActionsTable' }) },
]

export const DASHBOARD = {
  id: 2306506, name: 'Mikka 数据库与错误', pinned: true, tags: ['operations', 'issue-1324', 'tracing'],
  description: '按路由、来源、SQL 与错误原因检查生产链路。关键路径全量、普通流量采样；数量和 JSON 近似字节按每条 sample_rate 加权；预算沿用供应商数据，UTC 口径。',
  note: { body: readFileSync(new URL('dashboard-note.md', here), 'utf8').trimEnd(), layout: { h: 6, w: 12, x: 0, y: 0 } },
  monitoringDashboard: MONITORING_DASHBOARD,
}

const hourly = { calculation_interval: 'hourly', condition: { type: 'absolute_value' } }
/** The plan allows five alerts; these are all of them. Email goes to the subscribed users. */
export const ALERTS = [
  { key: 'monthly-50', id: '01a1a144-b73e-0000-37ee-ecdafb0b932e', insight: 'monthly-budget', name: 'Mikka transfer reaches 50% of 500 GB plan allowance',
    ...hourly, enabled: true, threshold: { type: 'absolute', bounds: { upper: 0.5 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'first_row' } },
  { key: 'heartbeat', id: '01a1a144-bcba-0000-00ba-fb44e2874871', insight: 'heartbeat', name: 'Mikka monitoring collection failed or heartbeat absent',
    ...hourly, enabled: true, threshold: { type: 'absolute', bounds: { lower: 0.5 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'first_row' } },
  { key: 'source-anomaly', id: '01a1a9eb-1a3a-0000-6f0b-151446674319', insight: 'alert-source-anomaly', name: '[1324] Mikka 来源数据库小时异常',
    ...hourly, enabled: true, schedule_start_time: '00:15', threshold: { type: 'absolute', bounds: { upper: 0.5 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'first_row', label_column: 'source' } },
  { key: 'daily-pace', id: '01a1a144-b4dc-0000-fbbe-edbede0dfdb5', insight: 'alert-daily-pace', name: '[1324] Mikka 日速率外推超过500GB月额度',
    ...hourly, enabled: true, schedule_start_time: '00:15', threshold: { type: 'absolute', bounds: { upper: 1 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'first_row', label_column: 'source' } },
  { key: 'error-spike', id: '01a1a144-b9d6-0000-6229-896dc85243ec', insight: 'alert-error-spike', name: '[1324] Mikka 错误码小时突增',
    ...hourly, enabled: true, schedule_start_time: '00:15', threshold: { type: 'absolute', bounds: { upper: 0.5 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'first_row', label_column: 'source' } },
]

// --- comparison ------------------------------------------------------------

/** Deep equality on the fields we own; key order does not matter. */
export function same(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (!same(a[key], b[key])) return false
  return true
}

const insightTags = definition => [...new Set([...definition.tags, MANAGED_TAG, `key:${definition.key}`])].sort()

/** The changes that would make a remote insight match its definition; empty when it already does. */
export function insightChanges(definition, remote) {
  const changes = {}
  if (remote.name !== definition.name) changes.name = definition.name
  if ((remote.description ?? '') !== definition.description) changes.description = definition.description
  if (!same(remote.query, definition.query)) changes.query = definition.query
  const tags = insightTags(definition)
  if (!tags.every(tag => (remote.tags ?? []).includes(tag))) changes.tags = [...new Set([...(remote.tags ?? []), ...tags])].sort()
  return changes
}

function alertBody(definition, insightId) {
  return {
    name: definition.name, insight: insightId, enabled: definition.enabled,
    calculation_interval: definition.calculation_interval, condition: definition.condition,
    threshold: { configuration: definition.threshold }, config: definition.config,
    ...(definition.schedule_start_time ? { schedule_start_time: definition.schedule_start_time } : {}),
  }
}

export function alertChanges(definition, remote, insightId) {
  const want = alertBody(definition, insightId)
  const changes = {}
  for (const key of ['name', 'enabled', 'calculation_interval', 'schedule_start_time']) if (want[key] !== undefined && remote[key] !== want[key]) changes[key] = want[key]
  if ((remote.insight?.id ?? remote.insight) !== insightId) changes.insight = insightId
  if (!same(remote.condition, want.condition)) changes.condition = want.condition
  if (!same(remote.config, want.config)) changes.config = want.config
  if (!same(remote.threshold?.configuration, want.threshold.configuration)) changes.threshold = want.threshold
  return changes
}

// --- API -----------------------------------------------------------------

export function posthogApi({ key, host = 'https://us.posthog.com', project = '670821', fetchImpl = fetch }) {
  if (!/^phx_[A-Za-z0-9_-]{8,}$/.test(key ?? '')) throw new Error('POSTHOG_PERSONAL_API_KEY must be a personal API key (phx_…)')
  const base = `${host.replace(/\/$/, '')}/api/projects/${encodeURIComponent(project)}`
  const call = async (method, path, body) => {
    const response = await fetchImpl(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 404 && method === 'GET') return null
    // The status and path only: a response body can echo the request.
    if (!response.ok) throw new Error(`PostHog ${method} ${path.split('?')[0]} failed: ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  return {
    insightByShortId: async shortId => (await call('GET', `/insights/?short_id=${encodeURIComponent(shortId)}&limit=1`))?.results?.find(item => !item.deleted) ?? null,
    insightsByName: async name => ((await call('GET', `/insights/?search=${encodeURIComponent(name)}&saved=true&limit=100`))?.results ?? []).filter(item => !item.deleted),
    createInsight: body => call('POST', '/insights/', body),
    updateInsight: (id, body) => call('PATCH', `/insights/${id}/`, body),
    dashboard: id => call('GET', `/dashboards/${id}/`),
    dashboardsByName: async name => ((await call('GET', `/dashboards/?search=${encodeURIComponent(name)}&limit=100`))?.results ?? []).filter(item => !item.deleted),
    createDashboard: body => call('POST', '/dashboards/', body),
    updateDashboard: (id, body) => call('PATCH', `/dashboards/${id}/`, body),
    alerts: async () => (await call('GET', '/alerts/?limit=100'))?.results ?? [],
    createAlert: body => call('POST', '/alerts/', body),
    updateAlert: (id, body) => call('PATCH', `/alerts/${id}/`, body),
    me: () => fetchImpl(`${host.replace(/\/$/, '')}/api/users/@me/`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) }).then(r => r.ok ? r.json() : Promise.reject(new Error(`PostHog GET /api/users/@me failed: ${r.status}`))),
  }
}

// --- sync ------------------------------------------------------------------

/**
 * Brings PostHog to the definitions. With `apply: false` it only reads and
 * returns the plan. Returns `{ actions, ids }`: what was (or would be) done.
 */
export async function sync(api, { apply = false, log = () => {} } = {}) {
  const actions = []
  const act = async (description, work) => { actions.push(description); log(`${apply ? 'apply' : 'plan '}  ${description}`); return apply ? work() : undefined }

  // Dashboard first: new insights are created on it.
  let dashboard = await api.dashboard(DASHBOARD.id) ?? (await api.dashboardsByName(DASHBOARD.name)).find(item => item.name === DASHBOARD.name) ?? null
  if (dashboard?.deleted) dashboard = null
  const dashboardFields = { name: DASHBOARD.name, description: DASHBOARD.description, pinned: DASHBOARD.pinned, tags: DASHBOARD.tags }
  if (!dashboard) dashboard = await act(`create dashboard ${DASHBOARD.name}`, () => api.createDashboard(dashboardFields)) ?? null
  else {
    const changes = Object.fromEntries(Object.entries(dashboardFields).filter(([key, value]) => key === 'tags' ? !value.every(tag => (dashboard.tags ?? []).includes(tag)) : !same(dashboard[key], value)))
    if (changes.tags) changes.tags = [...new Set([...(dashboard.tags ?? []), ...DASHBOARD.tags])]
    if (Object.keys(changes).length) await act(`update dashboard ${dashboard.id} (${Object.keys(changes).join(', ')})`, () => api.updateDashboard(dashboard.id, changes))
  }

  const ids = {}
  for (const definition of INSIGHTS) {
    let remote = definition.shortId ? await api.insightByShortId(definition.shortId) : null
    if (!remote) {
      const candidates = await api.insightsByName(definition.name)
      remote = candidates.find(item => (item.tags ?? []).includes(`key:${definition.key}`)) ?? candidates.find(item => item.name === definition.name) ?? null
    }
    if (!remote) {
      const created = await act(`create insight ${definition.key}`, () => api.createInsight({
        name: definition.name, description: definition.description, query: definition.query, tags: insightTags(definition), saved: true,
        ...(definition.tile && dashboard?.id ? { dashboards: [dashboard.id] } : {}),
      }))
      ids[definition.key] = created?.id
      continue
    }
    ids[definition.key] = remote.id
    const changes = insightChanges(definition, remote)
    const onDashboard = (remote.dashboards ?? []).includes(dashboard?.id) || (remote.dashboard_tiles ?? []).some(tile => tile.dashboard_id === dashboard?.id && !tile.deleted)
    if (definition.tile && dashboard?.id && !onDashboard) changes.dashboards = [...new Set([...(remote.dashboards ?? []), dashboard.id])]
    if (Object.keys(changes).length) await act(`update insight ${definition.key} ${remote.short_id ?? remote.id} (${Object.keys(changes).join(', ')})`, () => api.updateInsight(remote.id, changes))
  }

  // Layout and the reading note, once every tile exists.
  if (dashboard?.id) {
    const current = apply ? await api.dashboard(dashboard.id) : dashboard
    const tiles = (current?.tiles ?? []).filter(tile => !tile.deleted)
    const updates = []
    for (const definition of INSIGHTS.filter(item => item.tile)) {
      const tile = tiles.find(item => item.insight && (item.insight.id === ids[definition.key] || item.insight.short_id === definition.shortId))
      if (tile && !same(tile.layouts?.sm, definition.tile)) updates.push({ id: tile.id, layouts: { ...tile.layouts, sm: definition.tile } })
    }
    const note = tiles.find(tile => tile.text)
    if (!note) updates.push({ text: { body: DASHBOARD.note.body }, layouts: { sm: DASHBOARD.note.layout } })
    else if (note.text.body !== DASHBOARD.note.body || !same(note.layouts?.sm, DASHBOARD.note.layout))
      updates.push({ id: note.id, text: { ...note.text, body: DASHBOARD.note.body }, layouts: { ...note.layouts, sm: DASHBOARD.note.layout } })
    if (updates.length) await act(`update dashboard ${dashboard.id} tiles (${updates.length})`, () => api.updateDashboard(dashboard.id, { tiles: updates }))
  }

  const alerts = await api.alerts()
  let subscriber
  for (const definition of ALERTS) {
    const insightId = ids[definition.insight]
    const remote = alerts.find(item => item.id === definition.id) ?? alerts.find(item => item.name === definition.name) ?? null
    if (!remote) {
      if (!insightId && apply) throw new Error(`Alert ${definition.key} has no insight`)
      subscriber ??= apply ? (await api.me()).id : undefined
      await act(`create alert ${definition.key}`, () => api.createAlert({ ...alertBody(definition, insightId), subscribed_users: [subscriber] }))
      continue
    }
    const changes = alertChanges(definition, remote, insightId)
    if (Object.keys(changes).length) await act(`update alert ${definition.key} (${Object.keys(changes).join(', ')})`, () => api.updateAlert(remote.id, changes))
  }
  return { actions, ids }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes('--apply'), check = argv.includes('--check')
  const api = posthogApi({ key: env.POSTHOG_PERSONAL_API_KEY, host: env.POSTHOG_HOST, project: env.POSTHOG_PROJECT_ID })
  const { actions } = await sync(api, { apply, log: line => console.log(line) })
  console.log(actions.length ? `${actions.length} change(s) ${apply ? 'applied' : 'pending'}` : 'PostHog matches the definitions')
  if (check && !apply && actions.length) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'posthog_sync_failed'); process.exitCode = 1 })
}

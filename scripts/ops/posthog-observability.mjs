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
const queriesChart = hourlyChart('estimated_queries_x10', '估算查询数（采样 ×10）', { style: 'number', decimalPlaces: 0 })
const bytesChart = hourlyChart('estimated_json_bytes_x10', '估算 JSON 字节（采样 ×10）', { style: 'short', suffix: ' B', decimalPlaces: 1 })
const single = { chartSettings: { showNullsAsZero: false } }

/** Every insight, in dashboard order. `shortId` is the production object; `tile` is its dashboard layout. */
export const INSIGHTS = [
  { key: 'daily-budget', shortId: 'CpCslHvh', name: 'Mikka daily transfer budget', tags: ['database-egress', 'operations'], tile: { h: 3, w: 6, x: 0, y: 6 },
    description: 'Latest known supplier value within 30 days; may be stale. Check monitoring heartbeat for collection health. No samples return NULL, never an assumed zero.',
    query: hogql(sql('daily-budget'), single) },
  { key: 'monthly-budget', shortId: 'Vy1tVOwr', name: 'Mikka billing-period transfer budget', tags: ['database-egress', 'operations'], tile: { h: 3, w: 6, x: 6, y: 6 },
    description: 'Latest known supplier value within 30 days; may be stale. Check monitoring heartbeat for collection health. No samples return NULL, never an assumed zero.',
    query: hogql(sql('monthly-budget'), single) },
  { key: 'coverage-7d', shortId: 'nQaTfq8D', name: '7d 数据覆盖与缺失属性 · 采样原数 / ×10', tags: ['issue-1324', 'tracing'], tile: { h: 4, w: 12, x: 0, y: 9 },
    description: 'UTC 首末 span 与实际覆盖小时；未归因 route 包含缺失、空串和 unknown。缺失小时不补零；仅 production。',
    query: hogql(sql('coverage'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  { key: 'route-queries-24h', shortId: 'kFw6Ai83', name: '24h 每小时数据库查询 · route Top 15 · 采样 ×10', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 6, x: 0, y: 13 },
    description: '按所选时间窗总采样查询数选出 Top 15；SQL 结果保留 sampled_queries。无数据小时不补零。UTC，边界小时可能不完整。',
    query: hogql(sql('route-queries'), { dateFrom: '-24h', display: 'ActionsLineGraph', chartSettings: queriesChart }) },
  { key: 'route-queries-7d', shortId: 'E31K4pde', name: '7d 每小时数据库查询 · route Top 15 · 采样 ×10', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 6, x: 6, y: 13 },
    description: '默认 7d 请求窗口；采集自 2026-11-05 02:38 UTC 开始，历史不足不补零。Top 15 按窗口总采样查询数。',
    query: hogql(sql('route-queries'), { dateFrom: '-7d', display: 'ActionsLineGraph', chartSettings: queriesChart }) },
  { key: 'route-bytes-24h', shortId: 'iSpRMGJo', name: '24h 每小时返回 JSON 近似字节 · route Top 15 · 采样 ×10', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 6, x: 0, y: 19 },
    description: '基于返回行 JSON 近似大小，非 Neon 传输或账单。按窗口字节总量取 Top 15；缺失字节不当作零。',
    query: hogql(sql('route-bytes'), { dateFrom: '-24h', display: 'ActionsLineGraph', chartSettings: bytesChart }) },
  { key: 'route-bytes-7d', shortId: '7F8ewK9A', name: '7d 每小时返回 JSON 近似字节 · route Top 15 · 采样 ×10', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 6, x: 6, y: 19 },
    description: '非 Neon 账单；采集自 2026-11-05 02:38 UTC 开始，历史不足不补零。缺字节值的查询见 sampled_queries_missing_bytes。',
    query: hogql(sql('route-bytes'), { dateFrom: '-7d', display: 'ActionsLineGraph', chartSettings: bytesChart }) },
  { key: 'client-kinds-7d', shortId: 'gAICaKyP', name: '7d 来源数据库查询与 JSON 近似字节 · 采样原数 / ×10', tags: ['issue-1324', 'tracing'], tile: { h: 5, w: 12, x: 0, y: 25 },
    description: 'web、daemon、mobile、cron、worker、background、workflow；daemon 来源是服务端归因，不代表 daemon 本地 span 已接入。',
    query: hogql(sql('client-kinds'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  { key: 'statements-7d', shortId: 'zBWWQsSI', name: '7d 大返回 SQL Top 20 · statement ID · 采样原数 / ×10', tags: ['issue-1324', 'tracing'], tile: { h: 8, w: 12, x: 0, y: 30 },
    description: '按估算 JSON 字节降序；参数化 SQL 最多 200 字符。缺字节值单独计数，非 Neon 账单或完整 SQL。',
    query: hogql(sql('statements'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  { key: 'error-causes-7d', shortId: 'yKovH9bi', name: '7d 错误原因 Top 100 · code / detail · 采样原数 / ×10', tags: ['issue-1324', 'tracing'], tile: { h: 5, w: 12, x: 0, y: 38 },
    description: '跨路由汇总 status_code=2 的错误 spans；未知 code/detail 明确显示。并非去重的失败请求数。',
    query: hogql(sql('error-causes'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  { key: 'errors-7d', shortId: 'y3Vykg2b', name: '7d 错误路由 Top 100 · route / code / detail · 采样原数 / ×10', tags: ['issue-1324', 'tracing'], tile: { h: 6, w: 12, x: 0, y: 43 },
    description: '仅 status_code=2；code 缺失回退 error.type，detail 缺失明确标记。同一失败可产生多个 spans，不是唯一失败请求数。',
    query: hogql(sql('errors'), { dateFrom: '-7d', display: 'ActionsTable' }) },
  // Alert-only insights: not on this dashboard (the heartbeat sits on the monitoring dashboard).
  { key: 'heartbeat', shortId: 'r8wuvlUx', name: 'Mikka monitoring heartbeat', tags: ['database-egress', 'operations'],
    description: 'Latest snapshot within one hour must be healthy and contain supplier hour/day fields. Missing or failed collection returns unhealthy.',
    query: hogql(sql('heartbeat'), single) },
  { key: 'alert-source-anomaly', shortId: 'k3M88Rs8', name: '[1324] Mikka 来源数据库小时异常', tags: ['mikka', 'issue-1324', 'observability', 'source-alerts'],
    description: 'DB samples > max(3×available 7d median,200 queries/1MB JSON≈2,000 queries/10MB at 10%). Warmup 24 prior observed full hours; launch/gaps excluded; absent routes zero-filled. Bytes require ≥95% coverage now and in ≥24 baseline hours. No current service telemetry→NULL. Monthly 50% and heartbeat remain.',
    query: hogql(sql('alert-source-anomaly'), { display: 'ActionsTable' }) },
  { key: 'alert-daily-pace', shortId: 'E08gP1zi', name: '[1324] Mikka 日速率外推超过5GB月预算', tags: ['mikka', 'issue-1324', 'observability', 'source-alerts'],
    description: 'UTC today bytes / elapsed hours through reported bucket ×24×month days vs 5GB. ≥3h; same UTC day; healthy snapshot≤60m/provider≤180m. Assumes complete provider day cumulative. Daily pace equivalent, not billing-period forecast; monthly 50% retained.',
    query: hogql(sql('alert-daily-pace'), { display: 'ActionsTable' }) },
  { key: 'alert-error-spike', shortId: 'STBizeTe', name: '[1324] Mikka 错误码小时突增', tags: ['mikka', 'issue-1324', 'observability', 'source-alerts'],
    description: 'Service+code error spans > max(3×available 7d median,5 samples≈50 spans at 10%). Only mikka-web/daemon; code→error.type→unknown_error. Warmup 24 observed full hours; code absences zero-filled only when service observed. No current telemetry→NULL. Routes are examples; spans≠failed requests.',
    query: hogql(sql('alert-error-spike'), { display: 'ActionsTable' }) },
]

export const DASHBOARD = {
  id: 2306506, name: 'Mikka 数据库与错误', pinned: true, tags: ['operations', 'issue-1324', 'tracing'],
  description: '按路由、来源、SQL 与错误原因检查生产链路。trace 默认 10% 采样，数量和 JSON 近似字节按 ×10 估算；预算沿用供应商数据，UTC 口径。',
  note: { body: readFileSync(new URL('dashboard-note.md', here), 'utf8'), layout: { h: 6, w: 12, x: 0, y: 0 } },
  monitoringDashboard: MONITORING_DASHBOARD,
}

const hourly = { calculation_interval: 'hourly', condition: { type: 'absolute_value' } }
/** The plan allows five alerts; these are all of them. Email goes to the subscribed users. */
export const ALERTS = [
  { key: 'monthly-50', id: '01a1a144-b73e-0000-37ee-ecdafb0b932e', insight: 'monthly-budget', name: 'Mikka transfer reaches 50% of 5 GB operating budget',
    ...hourly, enabled: true, threshold: { type: 'absolute', bounds: { upper: 0.5 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'first_row' } },
  { key: 'heartbeat', id: '01a1a144-bcba-0000-00ba-fb44e2874871', insight: 'heartbeat', name: 'Mikka monitoring collection failed or heartbeat absent',
    ...hourly, enabled: true, threshold: { type: 'absolute', bounds: { lower: 0.5 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'first_row' } },
  { key: 'source-anomaly', id: '01a1a9eb-1a3a-0000-6f0b-151446674319', insight: 'alert-source-anomaly', name: '[1324] Mikka 来源数据库小时异常',
    ...hourly, enabled: true, schedule_start_time: '00:15', threshold: { type: 'absolute', bounds: { upper: 0.5 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'any_row', label_column: 'source' } },
  { key: 'daily-pace', id: '01a1a144-b4dc-0000-fbbe-edbede0dfdb5', insight: 'alert-daily-pace', name: '[1324] Mikka 日速率外推超过5GB月预算',
    ...hourly, enabled: true, schedule_start_time: '00:15', threshold: { type: 'absolute', bounds: { upper: 1 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'any_row', label_column: 'source' } },
  { key: 'error-spike', id: '01a1a144-b9d6-0000-6229-896dc85243ec', insight: 'alert-error-spike', name: '[1324] Mikka 错误码小时突增',
    ...hourly, enabled: true, schedule_start_time: '00:15', threshold: { type: 'absolute', bounds: { upper: 0.5 } }, config: { type: 'HogQLAlertConfig', column: 'value', evaluation: 'any_row', label_column: 'source' } },
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

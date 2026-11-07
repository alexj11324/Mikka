import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ALERTS, DASHBOARD, INSIGHTS, MANAGED_TAG, alertChanges, insightChanges, posthogApi, sync } from './posthog-observability.mjs'

/** An in-memory PostHog with the API surface the script uses. */
function fakePosthog() {
  let next = 1
  const insights = [], dashboards = [], alerts = [], writes = []
  const clone = value => structuredClone(value)
  const tilesFor = dashboard => dashboard.tiles
  return {
    writes, store: { insights, dashboards, alerts },
    insightByShortId: async shortId => clone(insights.find(item => item.short_id === shortId) ?? null),
    insightsByName: async name => clone(insights.filter(item => item.name.includes(name))),
    createInsight: async body => {
      writes.push(['createInsight', body.name])
      const insight = { id: next++, short_id: `new${next}`, tags: [], dashboards: [], ...clone(body) }
      insights.push(insight)
      for (const id of body.dashboards ?? []) tilesFor(dashboards.find(d => d.id === id)).push({ id: next++, insight: { id: insight.id, short_id: insight.short_id }, layouts: {} })
      return clone(insight)
    },
    updateInsight: async (id, body) => {
      writes.push(['updateInsight', id, Object.keys(body)])
      const insight = insights.find(item => item.id === id)
      for (const dashboardId of (body.dashboards ?? []).filter(d => !insight.dashboards.includes(d)))
        tilesFor(dashboards.find(d => d.id === dashboardId)).push({ id: next++, insight: { id, short_id: insight.short_id }, layouts: {} })
      Object.assign(insight, clone(body))
      return clone(insight)
    },
    dashboard: async id => clone(dashboards.find(item => item.id === id) ?? null),
    dashboardsByName: async name => clone(dashboards.filter(item => item.name === name)),
    createDashboard: async body => { writes.push(['createDashboard']); const d = { id: next++, tiles: [], ...clone(body) }; dashboards.push(d); return clone(d) },
    updateDashboard: async (id, body) => {
      writes.push(['updateDashboard', id, Object.keys(body)])
      const dashboard = dashboards.find(item => item.id === id)
      const { tiles, ...fields } = clone(body)
      Object.assign(dashboard, fields)
      for (const tile of tiles ?? []) {
        const existing = tile.id && dashboard.tiles.find(item => item.id === tile.id)
        if (existing) Object.assign(existing, tile)
        else dashboard.tiles.push({ id: next++, ...tile })
      }
      return clone(dashboard)
    },
    alerts: async () => clone(alerts),
    createAlert: async body => { writes.push(['createAlert', body.name]); const a = { id: `alert-${next++}`, ...clone(body), threshold: { configuration: body.threshold.configuration } }; alerts.push(a); return clone(a) },
    updateAlert: async (id, body) => { writes.push(['updateAlert', id, Object.keys(body)]); Object.assign(alerts.find(a => a.id === id), clone(body)); return {} },
    me: async () => ({ id: 42 }),
  }
}

test('a fresh project gets the dashboard, every insight, the note and five alerts; a second run writes nothing', async () => {
  const posthog = fakePosthog()
  const first = await sync(posthog, { apply: true })
  assert.equal(posthog.store.dashboards.length, 1)
  assert.equal(posthog.store.insights.length, INSIGHTS.length)
  assert.equal(posthog.store.alerts.length, 5)
  const [dashboard] = posthog.store.dashboards
  assert.equal(dashboard.name, DASHBOARD.name)
  assert.equal(dashboard.tiles.filter(tile => tile.insight).length, INSIGHTS.filter(item => item.tile).length)
  assert.equal(dashboard.tiles.find(tile => tile.text)?.text.body, DASHBOARD.note.body)
  for (const definition of INSIGHTS.filter(item => item.tile)) {
    const insight = posthog.store.insights.find(item => item.name === definition.name)
    assert.ok(insight.tags.includes(MANAGED_TAG) && insight.tags.includes(`key:${definition.key}`))
    assert.deepEqual(dashboard.tiles.find(tile => tile.insight?.id === insight.id).layouts.sm, definition.tile)
  }
  for (const alert of posthog.store.alerts) assert.deepEqual(alert.subscribed_users, [42])
  assert.ok(first.actions.length > 0)

  posthog.writes.length = 0
  const second = await sync(posthog, { apply: true })
  assert.deepEqual(second.actions, [])
  assert.deepEqual(posthog.writes, [])
})

test('the plan is read-only and names only what differs', async () => {
  const posthog = fakePosthog()
  await sync(posthog, { apply: true })
  const alert = posthog.store.alerts.find(item => item.name === ALERTS.find(a => a.key === 'source-anomaly').name)
  alert.enabled = false
  const insight = posthog.store.insights.find(item => item.name === INSIGHTS.find(i => i.key === 'statements-7d').name)
  insight.query.source.query += '\n'
  posthog.writes.length = 0
  const { actions } = await sync(posthog)
  assert.deepEqual(posthog.writes, [])
  assert.equal(actions.length, 2)
  assert.match(actions.join('\n'), /update insight statements-7d .*\(query\)/)
  assert.match(actions.join('\n'), /update alert source-anomaly \(enabled\)/)
})

test('production objects found by id keep their other tags and subscribers', () => {
  const definition = INSIGHTS.find(item => item.key === 'monthly-budget')
  const remote = { name: definition.name, description: definition.description, query: structuredClone(definition.query), tags: ['database-egress', 'operations', 'extra'] }
  assert.deepEqual(insightChanges(definition, remote), { tags: ['database-egress', 'extra', MANAGED_TAG, 'key:monthly-budget', 'operations'].sort() })
  const alert = ALERTS.find(item => item.key === 'monthly-50')
  const production = { name: alert.name, enabled: true, calculation_interval: 'hourly', condition: { type: 'absolute_value' }, insight: { id: 7 },
    threshold: { configuration: { type: 'absolute', bounds: { upper: 0.5 } } }, config: alert.config, subscribed_users: [{ id: 1 }] }
  assert.deepEqual(alertChanges(alert, production, 7), {})
})

test('every alert reads one row: no any_row, and each SQL alert query aggregates to a single row', () => {
  // PostHog refuses an any_row alert whose query its LIMIT cuts short, and a
  // first_row alert on a multi-row query would check only one source.
  for (const alert of ALERTS) {
    assert.notEqual(alert.config.evaluation, 'any_row', `${alert.key} uses any_row`)
    const query = INSIGHTS.find(item => item.key === alert.insight).query.source.query
    const outer = query.slice(Math.max(0, query.lastIndexOf('\nSELECT')))
    // The outer SELECT groups nothing and either aggregates or reads a one-row CTE (LIMIT 1).
    const singleRow = !/\bGROUP BY\b/.test(outer) && (/\b(max|argMax|count)\(/.test(outer) || /\bLIMIT 1\b/.test(query))
    assert.ok(singleRow, `${alert.key} may return more than one row`)
    assert.doesNotMatch(outer, /\bLIMIT\s+(?!1\b)\d+/, `${alert.key} truncates its rows`)
  }
})

test('the API key is required and never appears in errors', async () => {
  assert.throws(() => posthogApi({ key: undefined }), /POSTHOG_PERSONAL_API_KEY/)
  assert.throws(() => posthogApi({ key: 'phc_projecttoken' }), /personal API key/)
  const key = 'phx_secretvalue123456'
  const api = posthogApi({ key, fetchImpl: async () => new Response(JSON.stringify({ detail: key }), { status: 403 }) })
  await assert.rejects(api.alerts(), error => !error.message.includes(key) && /403/.test(error.message))
})

test('only confirmed handled Workflow attempts and their exact wrappers leave the error alert', () => {
  const query = INSIGHTS.find(item => item.key === 'alert-error-spike').query.source.query
  const start = query.indexOf('    successful_traces AS (')
  assert.ok(start >= 0, 'the alert must classify handled attempts before aggregating errors')
  const filter = query.slice(start, query.indexOf('    service_start AS (')).trim().replace(/,$/, '')
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE spans (
      service_name TEXT, trace_id TEXT, span_id TEXT, parent_span_id TEXT,
      name TEXT, is_root_span INTEGER, status_code INTEGER, route TEXT,
      error_code TEXT, http_status INTEGER
    )`)
    const insert = db.prepare('INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    function add(trace, { rootStatus = 1, rootHttp = 200, root = true, service = 'mikka-web',
      job = false, cron = false, sdk = 'world.events.create run_started', wrapper = 'workflow.replay.load',
      http = 410, code = 'HTTP 410', route = '/.well-known/workflow/v1/flow' } = {}) {
      const row = (id, parent, name, status, error, httpCode = null, rootSpan = false, spanRoute = route) =>
        insert.run(service, trace, id, parent, name, Number(rootSpan), status, spanRoute, error, httpCode)
      if (root) row('root', '', job ? 'after:workflow-wake' : cron ? 'GET /api/cron/reconcile' : 'workflow.route.flow', rootStatus, 'unknown_error', job ? null : rootHttp, true, cron ? '/api/cron/reconcile' : route)
      row('wrapper', 'root', wrapper, 2, 'unknown_error')
      row('sdk', 'wrapper', sdk, 2, 'unknown_error')
      row('http', 'sdk', http === 404 ? 'http GET' : 'http POST', 2, code, http)
      row('transport', 'root', 'workflow.events.ws.connect', 2, 'TRANSPORT')
    }
    add('expired')
    add('duplicate-wait', { sdk: 'world.events.create wait_created', wrapper: 'workflow.run', http: 409, code: 'HTTP 409' })
    add('duplicate-step', { sdk: 'world.events.create step_started', wrapper: 'step.execute', http: 409, code: 'HTTP 409' })
    add('wake', { job: true, rootStatus: 0, sdk: 'world.hooks.getByToken', wrapper: 'hook.resume', http: 404, code: 'not-found', route: 'after:workflow-wake' })
    add('cron', { cron: true, sdk: 'world.hooks.getByToken', wrapper: 'cron:reconcile', http: 404, code: 'not-found', route: 'cron:reconcile' })
    add('failed-entry', { rootStatus: 2, rootHttp: 500 })
    add('missing-entry', { root: false })
    add('missing-http-status', { rootHttp: null })
    add('other-route', { route: '/api/rpc' })
    add('other-operation', { sdk: 'world.events.create run_completed', http: 409, code: 'HTTP 409' })
    add('other-error', { http: 500, code: 'not-found' })
    add('other-service', { service: 'mikka-daemon' })
    const excluded = db.prepare(`WITH ${filter} SELECT trace_id, span_id FROM handled_spans ORDER BY trace_id, span_id`).all()
      .map(row => `${row.trace_id}/${row.span_id}`)
    assert.deepEqual(excluded, [
      'cron/http', 'cron/sdk', 'duplicate-step/http', 'duplicate-step/sdk',
      'duplicate-wait/http', 'duplicate-wait/sdk', 'expired/http', 'expired/sdk', 'expired/wrapper',
      'wake/http', 'wake/sdk', 'wake/wrapper',
    ])
  } finally {
    db.close()
  }
})

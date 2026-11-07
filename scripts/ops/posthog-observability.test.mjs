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

function handledWorkflowSpans(rows) {
  const query = INSIGHTS.find(item => item.key === 'alert-error-spike').query.source.query
  const start = query.indexOf('    successful_entries AS (')
  assert.ok(start >= 0, 'success must belong to an entry, never a whole trace')
  const filter = query.slice(start, query.indexOf('    service_start AS (')).trim().replace(/,$/, '')
  const candidateStart = query.indexOf('AND (raw.is_root_span')
  const candidate = query.slice(candidateStart + 4, start).trim().replace(/\),$/, '').trim()
  const normalizationStart = query.indexOf("CASE WHEN raw.name LIKE 'workflow.execute %'")
  const normalizedName = query.slice(normalizationStart, query.indexOf(' AS name,', normalizationStart))
  const db = new DatabaseSync(':memory:')
  try {
    // Only adapt ClickHouse's Array(String)/JSON primitives; execute the actual
    // candidate predicate, parent joins, success predicates and role expansion.
    const array = value => value == null ? [] : JSON.parse(value)
    db.function('length', value => array(value).length)
    db.function('arrayElement', (value, index) => array(value)[index - 1] ?? '')
    db.function('isValidJSON', value => { try { JSON.parse(value); return 1 } catch { return 0 } })
    db.function('JSONExtractString', (value, key) => {
      try { const result = JSON.parse(value)?.[key]; return typeof result === 'string' ? result : '' } catch { return '' }
    })
    db.exec(`CREATE TABLE spans (
      service_name TEXT, trace_id TEXT, span_id TEXT, parent_span_id TEXT,
      name TEXT, is_root_span INTEGER, status_code INTEGER, route TEXT,
      error_code TEXT, http_status INTEGER, links TEXT
    )`)
    const insert = db.prepare('INSERT INTO spans VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const { service = 'mikka-web', trace = 'trace', id, parent, name, root = false, status = 0, route,
      error = 'unknown_error', http = null, links = [] } of rows)
      insert.run(service, trace, id, parent, name, Number(root), status, route, error, http, JSON.stringify(links))
    db.exec(`CREATE VIEW workflow_spans AS SELECT raw.service_name, raw.trace_id, raw.span_id,
      raw.parent_span_id, ${normalizedName} AS name, raw.is_root_span, raw.status_code, raw.route,
      raw.error_code, raw.http_status, raw.links FROM spans raw
      WHERE raw.service_name = 'mikka-web' AND ${candidate}`)
    return db.prepare(`WITH ${filter} SELECT trace_id, span_id FROM handled_spans ORDER BY trace_id, span_id`).all()
      .map(row => `${row.trace_id}/${row.span_id}`)
  } finally { db.close() }
}

function hookAttempt(parent, route, trace = 'trace') {
  return [
    { trace, id: 'resume', parent, name: 'hook.resume', status: 2, route },
    { trace, id: 'sdk', parent: 'resume', name: 'world.hooks.getByToken', status: 2, route },
    { trace, id: 'http', parent: 'sdk', name: 'http GET', status: 2, route, error: 'not-found', http: 404 },
    { trace, id: 'transport', parent, name: 'workflow.events.ws.connect', status: 2, route, error: 'TRANSPORT' },
  ]
}

const deliveryLink = (trace, span = 'delivery') => JSON.stringify({ trace_id: trace, span_id: span })

function flowAttempt(trace, { sdk = 'world.events.create run_started', wrapper = 'workflow.replay.load',
  http = 410, code = 'HTTP 410', route = '/.well-known/workflow/v1/flow',
  deliveryStatus = 1, deliveryHttp = 200, delivery = true, links = [deliveryLink(`${trace}-delivery`)],
  invocationStatus = 1, invocationError = 'unknown_error', legacyNames = false, service = 'mikka-web' } = {}) {
  const rows = [
    ...(delivery ? [{ trace: `${trace}-delivery`, id: 'delivery', parent: 'delivery-parent', name: 'workflow.route.flow', status: deliveryStatus,
      route: '/.well-known/workflow/v1/flow', http: deliveryHttp }] : []),
    { trace, id: 'invocation', parent: 'run-origin', name: legacyNames ? 'workflow.execute fixture' : 'workflow.execute',
      status: invocationStatus, route, error: invocationError, links },
    ...(wrapper ? [{ trace, id: 'wrapper', parent: 'invocation', name: legacyNames && wrapper === 'step.execute' ? 'step.execute fixture' : wrapper,
      status: 2, route }] : []),
    { trace, id: 'sdk', parent: wrapper ? 'wrapper' : 'invocation', name: sdk, status: 2, route },
    { trace, id: 'http', parent: 'sdk', name: http === 404 ? 'http GET' : 'http POST', status: 2, route, error: code, http },
    { trace, id: 'transport', parent: 'invocation', name: 'workflow.events.ws.connect', status: 2, route, error: 'TRANSPORT' },
  ]
  return rows.map(row => ({ ...row, service }))
}

function queuedFlowAttempt(trace, linked = false) {
  const deliveryTrace = linked ? trace : `${trace}-delivery`
  const rows = flowAttempt(trace, { links: [linked ? deliveryLink('origin', 'start') : deliveryLink(deliveryTrace, 'queue')] })
  rows.find(row => row.id === 'delivery').trace = deliveryTrace
  if (linked) rows.find(row => row.id === 'invocation').parent = 'queue'
  rows.push({ trace: deliveryTrace, id: 'queue', parent: 'delivery', name: 'vqs.process', status: 0,
    route: '/.well-known/workflow/v1/flow' })
  return rows
}

test('only confirmed handled Workflow attempts and their exact wrappers leave the error alert', () => {
  const rows = [
    ...flowAttempt('expired'),
    ...flowAttempt('duplicate-wait', { sdk: 'world.events.create wait_created', wrapper: 'workflow.run', http: 409, code: 'HTTP 409' }),
    ...flowAttempt('duplicate-step', { sdk: 'world.events.create step_started', wrapper: 'step.execute', http: 409, code: 'HTTP 409', legacyNames: true }),
    ...flowAttempt('failed-entry', { deliveryStatus: 2, deliveryHttp: 500 }),
    ...flowAttempt('missing-entry', { delivery: false }),
    ...flowAttempt('missing-http-status', { deliveryHttp: null }),
    ...flowAttempt('other-route', { route: '/api/rpc' }),
    ...flowAttempt('other-operation', { sdk: 'world.events.create run_completed', http: 409, code: 'HTTP 409' }),
    ...flowAttempt('other-error', { http: 500, code: 'not-found' }),
    ...flowAttempt('other-service', { service: 'mikka-daemon' }),
  ]
  assert.deepEqual(handledWorkflowSpans(rows), [
    'duplicate-step/http', 'duplicate-step/sdk', 'duplicate-wait/http', 'duplicate-wait/sdk',
    'expired/http', 'expired/sdk', 'expired/wrapper',
  ])
})

test('successful non-root wake and cron entries handle only their own exact hook attempts', () => {
  const rows = [
    { trace: 'wake', id: 'request', parent: '', name: 'POST /api/rpc', root: true, route: '/api/rpc', http: 200 },
    { trace: 'wake', id: 'entry', parent: 'request', name: 'after:workflow-wake', route: 'after:workflow-wake' },
    ...hookAttempt('entry', 'after:workflow-wake', 'wake'),
    { trace: 'cron', id: 'request', parent: 'remote-parent', name: 'GET /api/cron/reconcile', route: '/api/cron/reconcile', http: 200 },
    { trace: 'cron', id: 'entry', parent: 'request', name: 'cron:reconcile', route: 'cron:reconcile' },
    ...hookAttempt('entry', 'cron:reconcile', 'cron'),
  ]
  assert.deepEqual(handledWorkflowSpans(rows), [
    'cron/http', 'cron/resume', 'cron/sdk', 'wake/http', 'wake/resume', 'wake/sdk',
  ])
})

test('another successful entry in the same trace never handles a failed child entry', () => {
  const rows = [
    { id: 'success', parent: '', name: 'GET /api/cron/reconcile', root: true, route: '/api/cron/reconcile', http: 200 },
    { id: 'failed', parent: 'success', name: 'after:workflow-wake', status: 2, route: 'after:workflow-wake' },
    ...hookAttempt('failed', 'after:workflow-wake'),
  ]
  assert.deepEqual(handledWorkflowSpans(rows), [])
})

for (const [name, options] of [
  ['missing link', { links: [] }],
  ['multiple links', { links: [deliveryLink('guard-delivery'), deliveryLink('guard-delivery')] }],
  ['malformed link', { links: ['{'] }],
  ['missing link trace ID', { links: [JSON.stringify({ span_id: 'delivery' })] }],
  ['wrong link trace', { links: [deliveryLink('another-delivery')] }],
  ['wrong link span', { links: [deliveryLink('guard-delivery', 'another-span')] }],
  ['failed invocation', { invocationStatus: 2 }],
  ['business error on normal return', { invocationStatus: 1, invocationError: 'TypeError' }],
  ['unknown intermediate span', { wrapper: 'unknown.wrapper' }],
]) test(`a ${name} keeps the flow errors`, () => {
  assert.deepEqual(handledWorkflowSpans(flowAttempt('guard', options)), [])
})

test('a successful delivery in the same trace cannot replace the failed linked delivery', () => {
  const rows = flowAttempt('shared', { deliveryStatus: 2, deliveryHttp: 500 })
  rows.push({ trace: 'shared', id: 'other-delivery', parent: '', name: 'workflow.route.flow', root: true,
    route: '/.well-known/workflow/v1/flow', status: 1, http: 200 })
  assert.deepEqual(handledWorkflowSpans(rows), [])
})

test('a legacy run-origin link alone never impersonates the invocation delivery', () => {
  const rows = flowAttempt('legacy', { links: [deliveryLink('origin', 'start')] })
  rows.push({ trace: 'origin', id: 'start', parent: '', name: 'workflow.start fixture', root: true,
    route: '/.well-known/workflow/v1/flow', status: 1, http: 200 })
  rows.push({ trace: 'legacy', id: 'local-delivery', parent: '', name: 'workflow.route.flow', root: true,
    route: '/.well-known/workflow/v1/flow', status: 1, http: 200 })
  assert.deepEqual(handledWorkflowSpans(rows), [])
})

test('a linked invocation keeps its exact successful delivery parent despite its separate run-origin link', () => {
  const rows = flowAttempt('legacy', { links: [deliveryLink('origin', 'start')], legacyNames: true })
  rows.find(row => row.id === 'delivery').trace = 'legacy'
  rows.find(row => row.id === 'invocation').parent = 'delivery'
  assert.deepEqual(handledWorkflowSpans(rows), ['legacy/http', 'legacy/sdk', 'legacy/wrapper'])
})

for (const linked of [false, true]) test(`${linked ? 'linked' : 'continuous'} mode follows only the exact vqs.process delivery hop`, () => {
  assert.deepEqual(handledWorkflowSpans(queuedFlowAttempt('queue-attempt', linked)), [
    'queue-attempt/http', 'queue-attempt/sdk', 'queue-attempt/wrapper',
  ])
})

for (const [name, change] of [
  ['failed queue', rows => { rows.find(row => row.id === 'queue').status = 2 }],
  ['typed queue error', rows => { rows.find(row => row.id === 'queue').error = 'REAL_QUEUE_FAILURE' }],
  ['unknown queue span', rows => { rows.find(row => row.id === 'queue').name = 'unknown.queue' }],
  ['wrong queue parent', rows => { rows.find(row => row.id === 'queue').parent = 'another-delivery' }],
  ['cross-service queue', rows => { rows.find(row => row.id === 'queue').service = 'mikka-daemon' }],
  ['failed delivery', rows => { rows.find(row => row.id === 'delivery').http = 500 }],
  ['typed delivery error', rows => { rows.find(row => row.id === 'delivery').error = 'REAL_DELIVERY_FAILURE' }],
  ['extra queue hop', rows => {
    const queue = rows.find(row => row.id === 'queue')
    rows.push({ ...queue, id: 'extra-queue' })
    queue.parent = 'extra-queue'
  }],
]) test(`a ${name} cannot borrow another successful entry to hide errors`, () => {
  for (const linked of [false, true]) {
    const rows = queuedFlowAttempt('guard-queue', linked)
    change(rows)
    rows.push({ trace: rows.find(row => row.id === 'queue').trace, id: 'unrelated-delivery', parent: '',
      name: 'workflow.route.flow', status: 1, http: 200, route: '/.well-known/workflow/v1/flow' })
    assert.deepEqual(handledWorkflowSpans(rows), [], linked ? 'linked' : 'continuous')
  }
})

test('two invocations in one trace retain the failed invocation even with a shared successful delivery', () => {
  const rows = flowAttempt('shared')
  const failed = flowAttempt('shared', { invocationStatus: 2 }).filter(row => row.trace === 'shared')
    .map(row => ({ ...row, id: `failed-${row.id}`, parent: row.parent === 'run-origin' ? row.parent : `failed-${row.parent}` }))
  assert.deepEqual(handledWorkflowSpans([...rows, ...failed]), ['shared/http', 'shared/sdk', 'shared/wrapper'])
})

test('a direct event write uses its exact cross-trace invocation link without requiring a root delivery', () => {
  assert.deepEqual(handledWorkflowSpans(flowAttempt('direct', { wrapper: null })), ['direct/http', 'direct/sdk'])
})

test('a direct cron lookup still requires the corresponding successful HTTP entry', () => {
  const rows = [
    { id: 'request', parent: 'remote', name: 'GET /api/cron/reconcile', route: '/api/cron/reconcile', http: 200 },
    { id: 'cron', parent: 'request', name: 'cron:reconcile', route: 'cron:reconcile' },
    ...hookAttempt('cron', 'cron:reconcile').filter(row => row.id !== 'resume')
      .map(row => row.id === 'sdk' ? { ...row, parent: 'cron' } : row),
  ]
  assert.deepEqual(handledWorkflowSpans(rows), ['trace/http', 'trace/sdk'])
  rows[0].http = 502
  rows.push({ id: 'other-request', parent: '', name: 'GET /api/cron/reconcile', root: true,
    route: '/api/cron/reconcile', http: 200 })
  assert.deepEqual(handledWorkflowSpans(rows), [])
})

test('a real SDK error code or an unrelated failed sibling is never hidden', () => {
  const rows = flowAttempt('typed')
  rows.find(row => row.id === 'sdk').error = 'REAL_FAILURE'
  assert.deepEqual(handledWorkflowSpans(rows), [])
  rows.find(row => row.id === 'sdk').error = 'unknown_error'
  rows.find(row => row.id === 'wrapper').error = 'REAL_WRAPPER_FAILURE'
  assert.deepEqual(handledWorkflowSpans(rows), ['typed/http', 'typed/sdk'])
})

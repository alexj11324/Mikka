import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { errorAlertFixtures, fixtureDigest, syntheticErrorQuery, verifySyntheticResult } from './posthog-alert-acceptance.mjs'
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

// The engine result is an explicit recorded validation, not a CI network query.
// Any SQL or fixture edit invalidates it until the exact synthetic SELECT is rerun.
const readEngineReceipt = () => JSON.parse(readFileSync(new URL('./posthog/error-spike-engine-receipt.json', import.meta.url), 'utf8'))

test('the exact error-alert SQL and fixtures retain their verified real HogQL result', () => {
  const receipt = readEngineReceipt()
  const cases = errorAlertFixtures()
  const source = INSIGHTS.find(item => item.key === 'alert-error-spike').query.source.query
  assert.equal(receipt.schema_version, 1)
  assert.equal(receipt.kind, 'synthetic_hogql_readonly')
  assert.equal(receipt.project_id, 670821)
  assert.equal(receipt.production_acceptance, false)
  assert.equal(receipt.ci_executes_remote_query, false)
  assert.equal(receipt.sql_sha256, fixtureDigest(source))
  assert.equal(receipt.fixtures_sha256, fixtureDigest(JSON.stringify(cases)))
  assert.equal(receipt.acceptance_script_sha256, fixtureDigest(readFileSync(new URL('./posthog-alert-acceptance.mjs', import.meta.url))))
  assert.equal(receipt.baseline_sha256, fixtureDigest(receipt.baseline_sql))
  const metricTail = sql => sql.slice(sql.indexOf('    service_start AS ('))
  assert.equal(metricTail(source), metricTail(receipt.baseline_sql), 'preserve the owner array coverage and baseline computation')
  const query = syntheticErrorQuery(source, cases, receipt.baseline_sql)
  assert.equal(receipt.synthetic_query_sha256, fixtureDigest(query))
  assert.equal(receipt.result_sha256, fixtureDigest(receipt.result))
  assert.equal(query.includes('posthog.'), false, 'synthetic validation must not read production tables')
  const verified = verifySyntheticResult(receipt.result, cases)
  assert.deepEqual(verified.summary, receipt.summary)
  // These are the two demonstrated old defects, not merely a different query hash.
  for (const name of ['successful non-root wake and cron entries handle only their own exact hook attempts',
    'another successful entry in the same trace never handles a failed child entry']) {
    const fixture = cases.find(item => item.name === name)
    assert.equal(verified.rows.find(row => row.id === fixture.id).baselinePassed, 0)
  }
  assert.equal(verified.rows.find(row => row.id === cases.at(-1).id).baselinePassed, 1, 'legacy linked root behavior stays supported')
  const duplicate = cases.find(item => item.name === 'duplicate physical span rows do not become different excluded identities')
  const duplicateResult = verified.rows.find(row => row.id === duplicate.id)
  assert.equal(duplicateResult.distinct, 3)
  assert.equal(duplicateResult.raw, 4)
})

test('the recorded engine response rejects truncation, extra columns and altered identities', () => {
  const { result } = readEngineReceipt()
  assert.throws(() => verifySyntheticResult(result.split('\n').slice(0, -1).join('\n')), /ALERT_ENGINE_/)
  const lines = result.split('\n')
  const detail = lines.findIndex(line => line.startsWith('case-'))
  const extraColumn = [...lines]
  extraColumn[detail] += '|unexpected'
  assert.throws(() => verifySyntheticResult(extraColumn.join('\n')), /ALERT_ENGINE_RESULT_COLUMNS/)
  const changedIdentity = [...lines]
  const fields = changedIdentity[detail].split('|')
  fields[1] = 'ids:unexpected/http'
  changedIdentity[detail] = fields.join('|')
  assert.throws(() => verifySyntheticResult(changedIdentity.join('\n')), /ALERT_ENGINE_IDENTITY_MISMATCH/)
})

test('the error insight description fits the official targeted update schema', () => {
  assert.ok(INSIGHTS.find(item => item.key === 'alert-error-spike').description.length <= 400)
})

test('the official query-only acceptance entry emits the exact verified packet without contacting PostHog', () => {
  const query = execFileSync(process.execPath, [fileURLToPath(new URL('./posthog-alert-acceptance.mjs', import.meta.url)), '--query-only'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1048576,
  })
  assert.equal(fixtureDigest(query), readEngineReceipt().synthetic_query_sha256)
})

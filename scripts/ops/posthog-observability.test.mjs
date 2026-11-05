import assert from 'node:assert/strict'
import { test } from 'node:test'
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

test('any-row alerts stay within the 50 rows PostHog evaluates', () => {
  for (const alert of ALERTS.filter(item => item.config.evaluation === 'any_row')) {
    const query = INSIGHTS.find(item => item.key === alert.insight).query.source.query
    const limit = Number(/LIMIT (\d+)\s*$/.exec(query)?.[1] ?? (/LIMIT 1\b/.test(query) ? 1 : NaN))
    assert.ok(limit <= 50, `${alert.key} returns up to ${limit} rows`)
  }
})

test('the API key is required and never appears in errors', async () => {
  assert.throws(() => posthogApi({ key: undefined }), /POSTHOG_PERSONAL_API_KEY/)
  assert.throws(() => posthogApi({ key: 'phc_projecttoken' }), /personal API key/)
  const key = 'phx_secretvalue123456'
  const api = posthogApi({ key, fetchImpl: async () => new Response(JSON.stringify({ detail: key }), { status: 403 }) })
  await assert.rejects(api.alerts(), error => !error.message.includes(key) && /403/.test(error.message))
})

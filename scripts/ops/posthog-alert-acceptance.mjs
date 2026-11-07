#!/usr/bin/env node
// Query-only regression on PostHog's native HogQL engine; creates no events or configuration.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { INSIGHTS } from './posthog-observability.mjs'

const source = INSIGHTS.find(item => item.key === 'alert-error-spike').query.source.query
const start = source.indexOf('    workflow_traces AS (')
const end = source.indexOf('    service_start AS (')
assert.ok(start >= 0 && end > start, 'the alert must classify handled attempts before aggregating errors')
const filter = source.slice(start, end).trim().replace(/,$/, '')
const columns = ['service_name', 'trace_id', 'span_id', 'parent_span_id', 'is_root_span', 'name', 'status_code', 'http_status', 'route', 'error_code']
const rows = []

function add(trace, { rootStatus = 1, rootHttp = 200, root = true, service = 'mikka-web',
  job = false, cron = false, sdk = 'world.events.create run_started', wrapper = 'workflow.replay.load',
  http = 410, code = 'HTTP 410', route = '/.well-known/workflow/v1/flow' } = {}) {
  const row = (id, parent, name, status, error, httpCode = null, rootSpan = false, spanRoute = route) =>
    rows.push([service, trace, id, parent, Number(rootSpan), name, status, httpCode, spanRoute, error])
  if (root) row('root', '', job ? 'after:workflow-wake' : cron ? 'GET /api/cron/reconcile' : 'workflow.route.flow',
    rootStatus, 'unknown_error', job ? null : rootHttp, true, cron ? '/api/cron/reconcile' : route)
  if (wrapper) row('wrapper', 'root', wrapper, 2, 'unknown_error')
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
add('failed-http-entry', { rootHttp: 500 })
add('missing-entry', { root: false })
add('missing-http-status', { rootHttp: null })
add('other-route', { route: '/api/rpc' })
add('other-operation', { sdk: 'world.events.create run_completed', http: 409, code: 'HTTP 409' })
add('other-error', { http: 500, code: 'not-found' })
add('other-service', { service: 'mikka-daemon' })
add('missing-grandparent', { wrapper: null })
add('wrong-grandparent', { wrapper: 'workflow.run' })

const literal = value => value === null ? 'NULL' : typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value)
const fixtures = rows.map(row => `SELECT ${row.map((value, i) => `${literal(value)} AS ${columns[i]}`).join(', ')}`).join('\nUNION ALL\n')
const query = `WITH workflow_spans AS (${fixtures}),\n${filter}\nSELECT service_name, trace_id, span_id FROM handled_spans\nGROUP BY service_name, trace_id, span_id ORDER BY service_name, trace_id, span_id`
const context = 'Query-only synthetic regression for handled Workflow alert exclusions; no events, configuration or data are written'
const response = JSON.parse(execFileSync('posthog-cli', ['api', 'call', '--project-id', '670821', '--json', 'execute-sql', JSON.stringify({ query, context })], {
  encoding: 'utf8', timeout: 60_000,
}))
assert.equal(typeof response.results, 'string', 'PostHog must return the native query result table')
const [header, ...data] = response.results.trim().split('\n')
assert.equal(header, 'service_name|trace_id|span_id')
const excluded = data.map(line => line.split('|').join('/'))
assert.deepEqual(excluded, [
  'cron/http', 'cron/sdk', 'duplicate-step/http', 'duplicate-step/sdk',
  'duplicate-wait/http', 'duplicate-wait/sdk', 'expired/http', 'expired/sdk', 'expired/wrapper',
  'missing-grandparent/http', 'missing-grandparent/sdk', 'wake/http', 'wake/sdk', 'wake/wrapper',
  'wrong-grandparent/http', 'wrong-grandparent/sdk',
].map(span => `mikka-web/${span}`))
console.log(`Native HogQL acceptance passed: ${excluded.length} handled spans excluded; genuine error fixtures retained.`)

#!/usr/bin/env node
// PostHog native HogQL acceptance. Default: one synthetic read-only query.
// --query-only prints that exact query for review/MCP execution; importing never queries.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { INSIGHTS } from './posthog-observability.mjs'

// Closed synthetic data only. These cases run through the actual source SQL in
// PostHog; CI verifies the recorded engine result's source/fixture hashes.
export function errorAlertFixtures() {
  const cases = []
  const fixture = (name, build) => build((rows, expected, suffix) => {
    cases.push({ id: `case-${String(cases.length + 1).padStart(3, '0')}`,
      name: suffix ? `${name} (${suffix})` : name,
      rows: JSON.parse(JSON.stringify(rows)), expected: [...expected].sort() })
  })
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

  fixture('only confirmed handled Workflow attempts and their exact wrappers leave the error alert', (check) => {
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
    check(rows, [
      'duplicate-step/http', 'duplicate-step/sdk', 'duplicate-wait/http', 'duplicate-wait/sdk',
      'expired/http', 'expired/sdk', 'expired/wrapper',
    ])
  })

  fixture('successful non-root wake and cron entries handle only their own exact hook attempts', (check) => {
    const rows = [
      { trace: 'wake', id: 'request', parent: '', name: 'POST /api/rpc', root: true, route: '/api/rpc', http: 200 },
      { trace: 'wake', id: 'entry', parent: 'request', name: 'after:workflow-wake', route: 'after:workflow-wake' },
      ...hookAttempt('entry', 'after:workflow-wake', 'wake'),
      { trace: 'cron', id: 'request', parent: 'remote-parent', name: 'GET /api/cron/reconcile', route: '/api/cron/reconcile', http: 200 },
      { trace: 'cron', id: 'entry', parent: 'request', name: 'cron:reconcile', route: 'cron:reconcile' },
      ...hookAttempt('entry', 'cron:reconcile', 'cron'),
    ]
    check(rows, [
      'cron/http', 'cron/resume', 'cron/sdk', 'wake/http', 'wake/resume', 'wake/sdk',
    ])
  })

  fixture('another successful entry in the same trace never handles a failed child entry', (check) => {
    const rows = [
      { id: 'success', parent: '', name: 'GET /api/cron/reconcile', root: true, route: '/api/cron/reconcile', http: 200 },
      { id: 'failed', parent: 'success', name: 'after:workflow-wake', status: 2, route: 'after:workflow-wake' },
      ...hookAttempt('failed', 'after:workflow-wake'),
    ]
    check(rows, [])
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
  ]) fixture(`a ${name} keeps the flow errors`, (check) => {
    check(flowAttempt('guard', options), [])
  })

  fixture('a successful delivery in the same trace cannot replace the failed linked delivery', (check) => {
    const rows = flowAttempt('shared', { deliveryStatus: 2, deliveryHttp: 500 })
    rows.push({ trace: 'shared', id: 'other-delivery', parent: '', name: 'workflow.route.flow', root: true,
      route: '/.well-known/workflow/v1/flow', status: 1, http: 200 })
    check(rows, [])
  })

  fixture('a legacy run-origin link alone never impersonates the invocation delivery', (check) => {
    const rows = flowAttempt('legacy', { links: [deliveryLink('origin', 'start')] })
    rows.push({ trace: 'origin', id: 'start', parent: '', name: 'workflow.start fixture', root: true,
      route: '/.well-known/workflow/v1/flow', status: 1, http: 200 })
    rows.push({ trace: 'legacy', id: 'local-delivery', parent: '', name: 'workflow.route.flow', root: true,
      route: '/.well-known/workflow/v1/flow', status: 1, http: 200 })
    check(rows, [])
  })

  fixture('a linked invocation keeps its exact successful delivery parent despite its separate run-origin link', (check) => {
    const rows = flowAttempt('legacy', { links: [deliveryLink('origin', 'start')], legacyNames: true })
    rows.find(row => row.id === 'delivery').trace = 'legacy'
    rows.find(row => row.id === 'invocation').parent = 'delivery'
    check(rows, ['legacy/http', 'legacy/sdk', 'legacy/wrapper'])
  })

  for (const linked of [false, true]) fixture(`${linked ? 'linked' : 'continuous'} mode follows only the exact vqs.process delivery hop`, (check) => {
    check(queuedFlowAttempt('queue-attempt', linked), [
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
  ]) fixture(`a ${name} cannot borrow another successful entry to hide errors`, (check) => {
    for (const linked of [false, true]) {
      const rows = queuedFlowAttempt('guard-queue', linked)
      change(rows)
      rows.push({ trace: rows.find(row => row.id === 'queue').trace, id: 'unrelated-delivery', parent: '',
        name: 'workflow.route.flow', status: 1, http: 200, route: '/.well-known/workflow/v1/flow' })
      check(rows, [], linked ? 'linked' : 'continuous')
    }
  })

  fixture('two invocations in one trace retain the failed invocation even with a shared successful delivery', (check) => {
    const rows = flowAttempt('shared')
    const failed = flowAttempt('shared', { invocationStatus: 2 }).filter(row => row.trace === 'shared')
      .map(row => ({ ...row, id: `failed-${row.id}`, parent: row.parent === 'run-origin' ? row.parent : `failed-${row.parent}` }))
    check([...rows, ...failed], ['shared/http', 'shared/sdk', 'shared/wrapper'])
  })

  fixture('a direct event write uses its exact cross-trace invocation link without requiring a root delivery', (check) => {
    check(flowAttempt('direct', { wrapper: null }), ['direct/http', 'direct/sdk'])
  })

  fixture('a direct cron lookup still requires the corresponding successful HTTP entry', (check) => {
    const rows = [
      { id: 'request', parent: 'remote', name: 'GET /api/cron/reconcile', route: '/api/cron/reconcile', http: 200 },
      { id: 'cron', parent: 'request', name: 'cron:reconcile', route: 'cron:reconcile' },
      ...hookAttempt('cron', 'cron:reconcile').filter(row => row.id !== 'resume')
        .map(row => row.id === 'sdk' ? { ...row, parent: 'cron' } : row),
    ]
    check(rows, ['trace/http', 'trace/sdk'])
    rows[0].http = 502
    rows.push({ id: 'other-request', parent: '', name: 'GET /api/cron/reconcile', root: true,
      route: '/api/cron/reconcile', http: 200 })
    check(rows, [])
  })

  fixture('a real SDK error code or an unrelated failed sibling is never hidden', (check) => {
    const rows = flowAttempt('typed')
    rows.find(row => row.id === 'sdk').error = 'REAL_FAILURE'
    check(rows, [])
    rows.find(row => row.id === 'sdk').error = 'unknown_error'
    rows.find(row => row.id === 'wrapper').error = 'REAL_WRAPPER_FAILURE'
    check(rows, ['typed/http', 'typed/sdk'])
  })
  fixture('wait_completed is handled only by its own successful invocation', (check) => {
    const rows = flowAttempt('wait-completed', { sdk: 'world.events.create wait_completed', wrapper: null, http: 409, code: 'HTTP 409' })
    check(rows, ['wait-completed/http', 'wait-completed/sdk'])
    rows.find(row => row.id === 'invocation').status = 2
    check(rows, [])
  })

  function nudgeAttempt(post = false) {
    const route = 'workflow:coordinatorWakeDeadline/nudgeWorkflow'
    return [
      // The inner span starts before contextStorage.run installs stepMetadata.
      { id: 'step', parent: 'outer-step', name: 'step.execute', status: 1, route: '/.well-known/workflow/v1/flow' },
      ...hookAttempt('step', route).map(row => row.id === 'sdk' && post
        ? { ...row, name: 'world.events.create hook_received' }
        : row.id === 'http' && post ? { ...row, name: 'http POST', error: 'HTTP 404' } : row),
    ]
  }
  for (const post of [false, true]) fixture(`nudge ${post ? 'hook_received' : 'lookup'} has its own successful inner step`, (check) => {
    check(nudgeAttempt(post), ['trace/http', 'trace/resume', 'trace/sdk'])
  })
  for (const [name, change] of [
    ['failed inner step', rows => { rows.find(row => row.id === 'step').status = 2 }],
    ['typed inner step error', rows => { rows.find(row => row.id === 'step').error = 'REAL_STEP_FAILURE' }],
    ['missing immediate owner', rows => { rows.find(row => row.id === 'resume').parent = 'missing-step' }],
    ['unknown intermediate', rows => {
      rows.find(row => row.id === 'resume').parent = 'unknown-wrapper'
      rows.push({ id: 'unknown-wrapper', parent: 'step', name: 'unknown.wrapper', status: 1, route: '/.well-known/workflow/v1/flow' })
    }],
    ['mismatched hook route', rows => { rows.find(row => row.id === 'resume').route = 'after:workflow-wake' }],
    ['mismatched SDK route', rows => { rows.find(row => row.id === 'sdk').route = 'after:workflow-wake' }],
    ['unrecognized client route', rows => { rows.find(row => row.id === 'http').route = '/api/rpc' }],
    ['typed SDK error', rows => { rows.find(row => row.id === 'sdk').error = 'REAL_SDK_FAILURE' }],
  ]) fixture(`nudge ${name} cannot borrow another successful step`, (check) => {
    for (const post of [false, true]) {
      const rows = nudgeAttempt(post)
      change(rows)
      rows.push({ id: 'other-step', parent: '', name: 'step.execute', status: 1, route: 'workflow:coordinatorWakeDeadline/nudgeWorkflow' })
      check(rows, [], post ? 'post' : 'get')
    }
  })
  fixture('a typed nudge wrapper error itself remains counted', (check) => {
    const rows = nudgeAttempt(true)
    rows.find(row => row.id === 'resume').error = 'REAL_WRAPPER_FAILURE'
    check(rows, ['trace/http', 'trace/sdk'])
  })
  fixture('two clients sharing one SDK and wrapper still have exact distinct identities', (check) => {
    const rows = flowAttempt('shared-client')
    rows.push({ ...rows.find(row => row.id === 'http'), id: 'http-retry' })
    check(rows, ['shared-client/http', 'shared-client/http-retry', 'shared-client/sdk', 'shared-client/wrapper'])
  })
  fixture('duplicate physical span rows do not become different excluded identities', (check) => {
    const rows = flowAttempt('duplicate-row')
    rows.push({ ...rows.find(row => row.id === 'http') })
    check(rows, ['duplicate-row/http', 'duplicate-row/sdk', 'duplicate-row/wrapper'])
  })
  fixture('a failed unrelated root cannot replace or erase the exact successful invocation proof', (check) => {
    const rows = queuedFlowAttempt('own-success')
    rows.push({ trace: 'own-success', id: 'other-root', parent: '', name: 'unrelated.root', root: true, status: 2, route: '/api/rpc', error: 'REAL_ROOT_FAILURE' })
    check(rows, ['own-success/http', 'own-success/sdk', 'own-success/wrapper'])
  })
  fixture('the historical linked root flow and queue topology remains handled', (check) => {
    const rows = queuedFlowAttempt('historical-linked', true)
    rows.find(row => row.id === 'delivery').root = true
    check(rows, ['historical-linked/http', 'historical-linked/sdk', 'historical-linked/wrapper'])
  })
  return cases
}

export const fixtureDigest = value => createHash('sha256').update(value).digest('hex')
const literal = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
const opaqueId = (caseId, kind, value) => value
  ? createHash('sha256').update(`${caseId}:${kind}:${value}`).digest().subarray(0, kind === 'trace' ? 16 : 8).toString('base64')
  : ''

/** Replace only the source table with literal fixtures; run the source CTEs unchanged. */
export function syntheticErrorQuery(source, cases, baseline) {
  const graphFor = (sql, prefix = '') => {
    const start = sql.indexOf('    workflow_spans AS (')
    const end = sql.indexOf('    service_start AS (')
    if (start < 0 || end <= start) throw new Error('ALERT_FIXTURE_SOURCE_BOUNDARY')
    let graph = sql.slice(start, end)
    if (graph.split('FROM posthog.trace_spans').length !== 2) throw new Error('ALERT_FIXTURE_SOURCE_TABLE')
    graph = graph.replace('FROM posthog.trace_spans', 'FROM fixture_source')
    if (prefix) {
      const names = [...graph.matchAll(/^    (\w+) AS \(/gm)].map(match => match[1])
      graph = graph.replace(new RegExp(`\\b(${names.join('|')})\\b`, 'g'), name => `${prefix}${name}`)
    }
    return graph
  }
  const rows = cases.flatMap(test => test.rows.map(row => {
    const trace = row.trace ?? 'trace'
    if (!/^[a-z0-9-]+$/.test(trace) || !/^[a-z0-9-]+$/.test(row.id)) throw new Error('ALERT_FIXTURE_ID')
    const links = (row.links ?? []).map(link => {
      try {
        const parsed = JSON.parse(link)
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return link
        if (typeof parsed.trace_id === 'string') parsed.trace_id = opaqueId(test.id, 'trace', parsed.trace_id)
        if (typeof parsed.span_id === 'string') parsed.span_id = opaqueId(test.id, 'span', parsed.span_id)
        return JSON.stringify(parsed)
      } catch { return link } // Malformed input is a deliberate fail-closed fixture.
    })
    const values = [test.id, trace, row.id, row.service ?? 'mikka-web', opaqueId(test.id, 'trace', trace),
      opaqueId(test.id, 'span', row.id), opaqueId(test.id, 'span', row.parent ?? ''), row.name,
      Number(row.root ?? false), row.status ?? 0, row.route ?? 'unknown', row.error ?? 'unknown_error', row.http == null ? '' : String(row.http)]
    return `(${values.map(value => typeof value === 'number' ? value : literal(value)).join(', ')}, [${links.map(literal).join(', ')}])`
  }))
  const expected = cases.map(test => `(${literal(test.id)}, [${test.expected.map(literal).join(', ')}])`)
  return `WITH
    toDateTime('2026-01-01 00:00:00', 'UTC') AS evaluated_hour,
    fixture_rows AS (SELECT arrayJoin([${rows.join(',\n')}]) AS r),
    fixture_source AS (
        SELECT evaluated_hour AS timestamp, r.4 AS service_name, r.5 AS trace_id, r.6 AS span_id,
            r.7 AS parent_span_id, r.8 AS name, r.9 AS is_root_span, r.10 AS status_code, r.14 AS links,
            map('mikka.route', r.11, 'mikka.error.code', r.12, 'http.response.status_code', r.13) AS attributes,
            map('deployment.environment.name', 'production') AS resource_attributes
        FROM fixture_rows
    ),
${graphFor(source)}${graphFor(baseline, 'baseline_')}
    fixture_identities AS (
        SELECT DISTINCT r.1 AS case_id, concat(r.2, '/', r.3) AS identity,
            r.4 AS service_name, r.5 AS trace_id, r.6 AS span_id FROM fixture_rows
    ),
    fixture_actual AS (
        SELECT f.case_id AS case_id, groupUniqArray(f.identity) AS identities, count() AS raw_count
        FROM fixture_identities f JOIN handled_spans h
          ON f.service_name = h.service_name AND f.trace_id = h.trace_id AND f.span_id = h.span_id
        GROUP BY f.case_id
    ),
    fixture_baseline AS (
        SELECT f.case_id AS case_id, groupUniqArray(f.identity) AS identities, count() AS raw_count
        FROM fixture_identities f JOIN baseline_handled_spans h
          ON f.service_name = h.service_name AND f.trace_id = h.trace_id AND f.span_id = h.span_id
        GROUP BY f.case_id
    ),
    fixture_expected AS (SELECT arrayJoin([${expected.join(',\n')}]) AS expectation),
    fixture_results AS (
        SELECT tupleElement(e.expectation, 1) AS case_id,
            concat('ids:', arrayStringConcat(arraySort(coalesce(a.identities, [])), ',')) AS actual_ids,
            concat('ids:', arrayStringConcat(arraySort(coalesce(b.identities, [])), ',')) AS baseline_ids,
            concat('ids:', arrayStringConcat(arraySort(tupleElement(e.expectation, 2)), ',')) AS expected_ids,
            length(coalesce(a.identities, [])) AS distinct_count, coalesce(a.raw_count, 0) AS raw_count,
            length(coalesce(b.identities, [])) AS baseline_distinct_count, coalesce(b.raw_count, 0) AS baseline_raw_count,
            length(tupleElement(e.expectation, 2)) AS expected_count,
            if(arraySort(coalesce(a.identities, [])) = arraySort(tupleElement(e.expectation, 2)), 1, 0) AS passed,
            if(arraySort(coalesce(b.identities, [])) = arraySort(tupleElement(e.expectation, 2)), 1, 0) AS baseline_passed
        FROM fixture_expected e LEFT JOIN fixture_actual a ON a.case_id = tupleElement(e.expectation, 1)
        LEFT JOIN fixture_baseline b ON b.case_id = tupleElement(e.expectation, 1)
    )
SELECT case_id, actual_ids, baseline_ids, expected_ids, distinct_count, raw_count, baseline_distinct_count, baseline_raw_count,
    expected_count, passed, baseline_passed, 1 AS case_count FROM fixture_results
UNION ALL
SELECT '__summary__' AS case_id, 'ids:' AS actual_ids, 'ids:' AS baseline_ids, 'ids:' AS expected_ids,
    sum(distinct_count) AS distinct_count, sum(raw_count) AS raw_count,
    sum(baseline_distinct_count) AS baseline_distinct_count, sum(baseline_raw_count) AS baseline_raw_count,
    sum(expected_count) AS expected_count, min(passed) AS passed, min(baseline_passed) AS baseline_passed, count() AS case_count FROM fixture_results
ORDER BY case_id`
}

/** Strictly verify the closed metadata table returned by execute-sql, not SQL semantics. */
export function verifySyntheticResult(result, cases = errorAlertFixtures()) {
  const header = 'case_id|actual_ids|baseline_ids|expected_ids|distinct_count|raw_count|baseline_distinct_count|baseline_raw_count|expected_count|passed|baseline_passed|case_count'
  if (typeof result !== 'string' || result.length > 131072) throw new Error('ALERT_ENGINE_RESULT_FORMAT')
  const lines = result.replace(/\n$/, '').split('\n')
  if (lines.shift() !== header || lines.length !== cases.length + 1) throw new Error('ALERT_ENGINE_RESULT_ROWS')
  const rows = lines.map(line => {
    const cells = line.split('|')
    if (cells.length !== 12) throw new Error('ALERT_ENGINE_RESULT_COLUMNS')
    const counts = cells.slice(4).map(cell => {
      if (!/^(0|[1-9]\d*)$/.test(cell) || !Number.isSafeInteger(Number(cell))) throw new Error('ALERT_ENGINE_RESULT_COUNT')
      return Number(cell)
    })
    return { id: cells[0], actual: cells[1], baseline: cells[2], expected: cells[3],
      distinct: counts[0], raw: counts[1], baselineDistinct: counts[2], baselineRaw: counts[3],
      expectedCount: counts[4], passed: counts[5], baselinePassed: counts[6], cases: counts[7] }
  })
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('ALERT_ENGINE_DUPLICATE_CASE')
  for (const test of cases) {
    const row = rows.find(row => row.id === test.id)
    const expected = `ids:${test.expected.join(',')}`
    if (!row || row.actual !== expected || row.expected !== expected || row.passed !== 1 || row.cases !== 1)
      throw new Error('ALERT_ENGINE_IDENTITY_MISMATCH')
    const allowed = new Set(test.rows.map(item => `${item.trace ?? 'trace'}/${item.id}`))
    if (!row.baseline.startsWith('ids:')) throw new Error('ALERT_ENGINE_BASELINE_FORMAT')
    const baseline = row.baseline.slice(4) ? row.baseline.slice(4).split(',') : []
    if (baseline.some(id => !allowed.has(id)) || new Set(baseline).size !== baseline.length
      || `ids:${[...baseline].sort().join(',')}` !== row.baseline) throw new Error('ALERT_ENGINE_BASELINE_IDENTITY')
    if (row.distinct !== test.expected.length || row.expectedCount !== test.expected.length || row.raw < row.distinct
      || row.baselineDistinct !== baseline.length || row.baselineRaw < baseline.length
      || row.baselinePassed !== Number(row.baseline === expected)) throw new Error('ALERT_ENGINE_COUNT_MISMATCH')
  }
  const summary = rows.find(row => row.id === '__summary__')
  const details = rows.filter(row => row.id !== '__summary__')
  const sum = key => details.reduce((total, row) => total + row[key], 0)
  if (!summary || summary.actual !== 'ids:' || summary.baseline !== 'ids:' || summary.expected !== 'ids:'
    || summary.cases !== cases.length || summary.passed !== 1
    || summary.baselinePassed !== Math.min(...details.map(row => row.baselinePassed))
    || ['distinct', 'raw', 'baselineDistinct', 'baselineRaw', 'expectedCount'].some(key => summary[key] !== sum(key)))
    throw new Error('ALERT_ENGINE_SUMMARY_MISMATCH')
  return { summary, rows: details }
}


function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || argv.length === 1 && argv[0] !== '--query-only') throw new Error('ALERT_ACCEPTANCE_ARGUMENTS')
  const source = INSIGHTS.find(item => item.key === 'alert-error-spike').query.source.query
  const receipt = JSON.parse(readFileSync(new URL('./posthog/error-spike-engine-receipt.json', import.meta.url), 'utf8'))
  const cases = errorAlertFixtures()
  const query = syntheticErrorQuery(source, cases, receipt.baseline_sql)
  if (argv[0] === '--query-only') { process.stdout.write(query); return }
  const context = 'Query-only synthetic regression of exact Workflow entry exclusions; literal fixtures only, no events or configuration writes'
  const input = JSON.stringify({ query, context, truncate: false })
  // Keep the original posthog-cli entry point and its 60s deadline. Never dump CLI stderr or credentials.
  if (Buffer.byteLength(input) >= 131072) throw new Error('ALERT_ACCEPTANCE_ARGUMENT_SIZE')
  const response = JSON.parse(execFileSync('posthog-cli', ['api', 'call', '--project-id', '670821', '--json', 'execute-sql', input], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1048576, stdio: ['pipe', 'pipe', 'pipe'],
  }))
  const verified = verifySyntheticResult(response.results, cases)
  console.log(JSON.stringify({ status: 'passed', cases: verified.summary.cases,
    distinct_excluded: verified.summary.distinct, raw_excluded: verified.summary.raw,
    baseline_cases_failed: verified.rows.filter(row => row.baselinePassed === 0).length }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main() } catch { console.error('POSTHOG_ALERT_ACCEPTANCE_FAILED'); process.exitCode = 1 }
}

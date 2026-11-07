import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { reconcile, REQUIRED_COLUMNS } from './reconcile-production-evidence.mjs'

const window = ['2026-11-07 10:00:00', '2026-11-07 10:10:00']
const at = '2026-11-07T10:00:01.000000Z'
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const span = n => n.toString(16).padStart(16, '0')
const trace = n => n.toString(16).padStart(32, '0')
const links = { run_id: uuid(1), thread_id: uuid(2), task_id: uuid(3), session_id: uuid(4) }
const ids = { run_id: links.run_id, thread_id: '', task_id: '' }
const clone = value => structuredClone(value)
const columns = name => REQUIRED_COLUMNS[name]
const row = (name, values) => ({ ...Object.fromEntries(columns(name).map(key => [key, null])), ...values })
function pages(rows) {
  const result = []
  for (let offset = 0; offset <= rows.length; offset += 500) {
    const chunk = rows.slice(offset, offset + 500)
    result.push({ offset, returnedRows: chunk.length, truncated: false, rows: chunk })
    if (chunk.length < 500) break
  }
  return result
}
const table = (name, rows, traceId) => ({ cluster: ['generation_receipts', 'ai_capture_summary'].includes(name) ? 'Default' : 'Logs',
  window, ...(traceId ? { traceId } : { ids }), columns: columns(name), pages: pages(rows.map(value => row(name, value))) })
const rows = value => value.pages.flatMap(page => page.rows)
function updateSummaries(tables) {
  const timeline = rows(tables.span_timeline), ai = rows(tables.generation_receipts)
  tables.trace_integrity.pages = pages([row('trace_integrity', { span_rows: timeline.length, distinct_span_ids: new Set(timeline.map(value => value.span_id_hex)).size,
    native_roots: 1, external_or_missing_parent_rows: 0, self_parent_rows: 0, run_ids: [links.run_id], task_ids: [links.task_id], session_ids: [links.session_id] })])
  tables.ai_capture_summary.pages = pages([row('ai_capture_summary', { generation_rows: ai.length, generation_event_ids: new Set(ai.map(value => value.event_uuid)).size,
    generation_span_ids: new Set(ai.map(value => value.span_id_hex)).size, invalid_span_id_rows: 0,
    with_input_usage: ai.length, with_output_usage: ai.length, with_cache_read_usage: ai.length, with_cache_creation_usage: ai.length,
    with_latency: ai.filter(value => value.latency_ms !== null).length, with_ttft: ai.filter(value => value.ttft_ms !== null).length,
    native_request_generations: ai.filter(value => value.timing_basis === 'official_cli_trace').length,
    app_server_fallback_generations: ai.filter(value => value.timing_basis === 'app_server_usage').length })])
  tables.capture_summary.pages = pages([{ signal: 'apm_span_ids', observed_count: new Set(timeline.map(value => value.span_id_hex)).size },
    { signal: 'native_log_rows', observed_count: rows(tables.safe_native_logs).length }, { signal: 'unsafe_log_body_rows', observed_count: 0 }])
}
function fixture(count = 1) {
  const traces = {}, lookup = []
  for (let n = 1; n <= count; n++) {
    const traceId = trace(n), timeline = [1, 2, 3].map(value => ({ started_utc: at, span_row_uuid: uuid(10 + value), span_id_hex: span(value),
      parent_span_id_hex: value === 1 ? span(0) : span(1), parent_presence: value === 1 ? 'root' : 'observed_parent',
      service: value === 1 ? 'mikka-web' : 'mikka-daemon', stage: ['workflow.execute', 'daemon.ai.generation', 'daemon.ai.collection'][value - 1], status_code: 0, ...links }))
    const common = { started_utc: at, span_id_hex: span(2), parent_span_id_hex: span(1), provider: 'codex', model: 'gpt-6-luna', operation: 'agent', harness: 'codex',
      timing_basis: 'official_cli_trace', ttft_basis: 'request_to_first_output_item', first_output_item_ms: 2,
      input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0, ttft_ms: 2, ...links }
    const data = {
      span_timeline: timeline,
      trace_integrity: [],
      generation_receipts: [{ ...common, event_uuid: uuid(30), latency_ms: 5, cache_reporting_exclusive_raw: 'false' }],
      safe_native_logs: [{ emitted_utc: at, log_uuid: uuid(40), trace_id_hex: traceId, span_id_hex: span(2), has_matching_apm_span: true, safe_body_shape: true, body_code: 'completed', ...links }],
      capture_summary: [],
      apm_generation_spans: [{ ...common, span_row_uuid: uuid(12), service: 'mikka-daemon', stage: 'daemon.ai.generation', model_latency_ms: 5, span_duration_ms: 5 }],
      ai_capture_summary: [],
      native_generation_collection: [{ emitted_utc: at, span_row_uuid: uuid(13), collection_span_id_hex: span(3), parent_span_id_hex: span(1), run_id: links.run_id, harness: 'codex',
        native_generations: 1, fallback_generations: 0, matched_fallbacks: 1, missing_native: 0, incomplete_requests: 0, invalid_spans: 0, rejected_batches: 0, duplicate_completions: 0,
        collection_truncated_raw: 'false', cli_exit_observed_raw: 'true', native_flush_confirmed_raw: 'false' }],
    }
    traces[traceId] = Object.fromEntries(Object.entries(data).map(([name, values]) => [name, table(name, values, traceId)]))
    for (const t of Object.values(traces[traceId])) for (const value of rows(t)) for (const field of ['span_row_uuid', 'event_uuid', 'log_uuid']) if (value[field]) value[field] = uuid(parseInt(value[field].slice(-12), 16) + n * 1000)
    updateSummaries(traces[traceId])
    // Lookup matches only an ID-bearing child, not every ancestor in the trace.
    lookup.push({ trace_id_hex: traceId, observed_span_ids: 1, run_ids: [links.run_id], thread_ids: [links.thread_id], task_ids: [links.task_id] })
  }
  const before = { capturedAt: '2026-11-07T10:11:00Z', lookup: table('lookup_trace_by_ids', lookup), traces }
  return { schemaVersion: 1, projectId: 670821, window, ids, snapshots: { before, after: { ...clone(before), capturedAt: '2026-11-07T10:12:00Z' } } }
}
const allTraces = manifest => Object.values(manifest.snapshots).flatMap(snapshot => Object.values(snapshot.traces))
const codes = report => new Set(report.problems.map(value => value.code))

test('log safety uses the completed/failed projection from the saved real query, not raw body text', () => {
  const saved = JSON.parse(readFileSync(new URL('./evidence/posthog-pagination-schema-191fcce2.json', import.meta.url), 'utf8'))
  const query = saved.queries.find(value => value.name === 'safe_native_logs')
  const response = JSON.parse(query.raw_response.content[0].text)
  assert.equal(response.query.query, query.executed_query)
  assert.match(query.executed_query, /l\.body = 'mikka\.stage\.completed', 'completed'/)
  assert.match(query.executed_query, /l\.body = 'mikka\.stage\.failed', 'failed'/)
  assert.ok(response.results.split('|').includes('body_code'))
  // The saved response is a schema preflight with zero rows. These are
  // synthetic values of its exact SQL projection, not production log evidence.
  for (const body_code of ['completed', 'failed']) {
    const manifest = fixture()
    for (const tables of allTraces(manifest)) rows(tables.safe_native_logs)[0].body_code = body_code
    assert.deepEqual(reconcile(manifest).problems, [])
  }
  for (const body_code of ['unexpected_body_redacted', 'mikka.stage.completed', 'mikka.stage.failed']) {
    const manifest = fixture()
    for (const tables of allTraces(manifest)) rows(tables.safe_native_logs)[0].body_code = body_code
    assert.ok(codes(reconcile(manifest)).has('capture_count'))
    for (const tables of allTraces(manifest)) rows(tables.capture_summary).find(value => value.signal === 'unsafe_log_body_rows').observed_count = 1
    assert.ok(codes(reconcile(manifest)).has('unsafe_log_body_observed'))
  }
})

test('all discovered traces reconcile without turning CLI exit or equal sets into upstream/production success', () => {
  const manifest = fixture(2), report = reconcile(manifest)
  assert.deepEqual(report.problems, [])
  assert.equal(report.traces.length, 4)
  assert.equal(report.status, 'sets_consistent')
  assert.equal(report.overallAcceptance, null)
  assert.equal(report.upstreamCompleteness, 'not_proven')
  assert.ok(report.limitations.some(value => value.code === 'native_flush_unconfirmed'))
  const duplicate = clone(manifest), first = duplicate.snapshots.after.traces[trace(1)], second = duplicate.snapshots.after.traces[trace(2)]
  rows(second.generation_receipts)[0].event_uuid = rows(first.generation_receipts)[0].event_uuid
  assert.ok(codes(reconcile(duplicate)).has('physical_uuid_reused_across_traces'))
  delete manifest.snapshots.after.traces[trace(2)]
  const missing = codes(reconcile(manifest))
  assert.ok(missing.has('all_discovered_traces_supplied'))
  assert.ok(missing.has('table_missing'))
})

test('501 rows require continuous pages and original UUIDs, including the explicit final short page', () => {
  const manifest = fixture()
  for (const tables of allTraces(manifest)) {
    const timeline = rows(tables.span_timeline)
    for (let i = 4; i <= 501; i++) timeline.push({ ...timeline[0], span_row_uuid: uuid(i + 100), span_id_hex: span(i), parent_span_id_hex: span(1), parent_presence: 'observed_parent' })
    tables.span_timeline.pages = pages(timeline); updateSummaries(tables)
  }
  assert.deepEqual(reconcile(manifest).problems, [])
  const tables = manifest.snapshots.after.traces[trace(1)]
  tables.span_timeline.pages[1].offset = 1000
  tables.span_timeline.pages[1].rows[0].span_row_uuid = tables.span_timeline.pages[0].rows[0].span_row_uuid
  let found = codes(reconcile(manifest))
  assert.ok(found.has('page_offset_gap')); assert.ok(found.has('physical_rows_unique'))
  tables.span_timeline.pages.pop()
  found = codes(reconcile(manifest))
  assert.ok(found.has('terminal_page_missing')); assert.ok(found.has('timeline_rows'))
})

test('equal row totals cannot hide different event, span, physical UUID, parent or model identities', () => {
  const manifest = fixture()
  for (const tables of allTraces(manifest)) {
    const apm = rows(tables.apm_generation_spans)[0]
    apm.span_row_uuid = uuid(99); apm.parent_span_id_hex = span(99); apm.model = 'different-model'
    rows(tables.generation_receipts)[0].span_id_hex = span(98)
  }
  const found = codes(reconcile(manifest))
  assert.ok(found.has('ai_apm_span_identity'))
  assert.ok(found.has('timeline_detail_physical_subset'))
  assert.ok(found.has('bucket_span_identity'))
  const aligned = fixture()
  rows(aligned.snapshots.after.traces[trace(1)].apm_generation_spans)[0].parent_span_id_hex = span(99)
  assert.ok(codes(reconcile(aligned)).has('generation_metadata_mismatch'))
})

test('native emissions and app-server receipts use distinct equations, without double counting matched fallbacks', () => {
  const manifest = fixture()
  for (const tables of allTraces(manifest)) {
    const ai = rows(tables.generation_receipts), apm = rows(tables.apm_generation_spans), timeline = rows(tables.span_timeline)
    for (const n of [4, 5]) {
      const event = { ...ai[0], event_uuid: uuid(30 + n), span_id_hex: span(n) }
      const generation = { ...apm[0], span_row_uuid: uuid(10 + n), span_id_hex: span(n) }
      if (n === 5) {
        Object.assign(event, { timing_basis: 'app_server_usage', ttft_basis: null, first_output_item_ms: null, latency_ms: null, ttft_ms: null })
        Object.assign(generation, { timing_basis: 'app_server_usage', ttft_basis: null, first_output_item_ms: null, model_latency_ms: null, ttft_ms: null })
      }
      ai.push(event); apm.push(generation); timeline.push({ ...timeline[1], span_id_hex: span(n), span_row_uuid: uuid(10 + n) })
    }
    tables.generation_receipts.pages = pages(ai); tables.apm_generation_spans.pages = pages(apm); tables.span_timeline.pages = pages(timeline)
    Object.assign(rows(tables.native_generation_collection)[0], { native_generations: 2, fallback_generations: 1, matched_fallbacks: 4, missing_native: 1 })
    updateSummaries(tables)
  }
  const report = reconcile(manifest)
  assert.deepEqual(report.problems, [])
  assert.equal(report.traces[0].nativeCounts[0].intendedEmissions, 3)
  assert.equal(report.traces[0].nativeCounts[0].observedAppServerReceipts, 5)
  const collection = manifest.snapshots.after.traces[trace(1)].native_generation_collection
  collection.pages[0].rows.push({ ...collection.pages[0].rows[0], span_row_uuid: uuid(999) }); collection.pages[0].returnedRows++
  const duplicate = reconcile(manifest)
  assert.ok(codes(duplicate).has('collection_logical_ids_unique'))
  assert.equal(duplicate.traces.at(-1).nativeCounts[0].intendedEmissions, 3)
})

test('missing fields/tables, wrong cluster/window, truncation and unstable aggregates remain incomplete', () => {
  const manifest = fixture(), tables = manifest.snapshots.after.traces[trace(1)]
  delete rows(tables.generation_receipts)[0].input_tokens
  delete tables.native_generation_collection
  tables.generation_receipts.cluster = 'Logs'
  tables.generation_receipts.window = ['2026-11-07 10:00:00', '2026-11-07 10:11:00']
  tables.generation_receipts.pages[0].truncated = true
  rows(tables.ai_capture_summary)[0].generation_event_ids++
  const report = reconcile(manifest), found = codes(report)
  for (const code of ['field_missing', 'table_missing', 'cluster_mismatch', 'query_scope_mismatch', 'page_truncated_or_unknown', 'ai_summary_count', 'snapshot_counts_or_identity_sets_unstable']) assert.ok(found.has(code), code)
  assert.equal(report.status, 'incomplete')
})

test('null is distinct from zero and arbitrary payload/labels never appear in output', () => {
  const manifest = fixture(), canary = 'SYNTHETIC_SECRET_email@example.invalid'
  for (const tables of allTraces(manifest)) {
    const ai = rows(tables.generation_receipts)[0], apm = rows(tables.apm_generation_spans)[0]
    for (const row of [ai, apm]) Object.assign(row, { operation: canary, model: canary, rawPayload: { password: canary } })
    ai.cache_read_tokens = null
    updateSummaries(tables)
    rows(tables.ai_capture_summary)[0].with_cache_read_usage = 0
  }
  const report = reconcile(manifest)
  assert.ok(codes(report).has('generation_numeric_mismatch'))
  assert.ok(report.limitations.some(value => value.code === 'generation_numeric_unknown'))
  assert.equal(JSON.stringify(report).includes(canary), false)
  const empty = fixture(); empty.snapshots.before.lookup.pages = pages([]); empty.snapshots.after.lookup.pages = pages([])
  assert.ok(codes(reconcile(empty)).has('lookup_empty_no_evidence'))
})

test('Claude equality preserves the missing independent upstream-count boundary; formatted MCP text is not normalized evidence', () => {
  const manifest = fixture()
  for (const tables of allTraces(manifest)) {
    tables.native_generation_collection.pages = pages([])
    tables.span_timeline.pages = pages(rows(tables.span_timeline).filter(value => value.stage !== 'daemon.ai.collection'))
    for (const table of [tables.generation_receipts, tables.apm_generation_spans]) Object.assign(rows(table)[0], {
      provider: 'anthropic', model: 'claude-haiku-5-5', harness: 'claude_code', timing_basis: null, ttft_basis: null, first_output_item_ms: null,
    })
    updateSummaries(tables)
  }
  const report = reconcile(manifest)
  assert.deepEqual(report.problems, [])
  assert.ok(report.limitations.some(value => value.code === 'claude_upstream_count_unavailable'))
  assert.equal(report.overallAcceptance, null)
  assert.ok(codes(reconcile({ results: 'span_id_hex|model\n0000000000000001|(null)' })).has('manifest_invalid'))
})

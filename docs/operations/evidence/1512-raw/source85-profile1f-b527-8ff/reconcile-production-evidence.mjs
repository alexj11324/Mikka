#!/usr/bin/env node
// Offline only: normalized metadata from the saved query templates, never raw MCP text.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const PAGE = 500, MAX_ROWS = 200_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TRACE = /^[0-9a-f]{32}$/, SPAN = /^[0-9a-f]{16}$/
const LINKS = ['run_id', 'thread_id', 'task_id', 'session_id']
const TOKENS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']
const COUNTERS = ['native_generations', 'fallback_generations', 'matched_fallbacks', 'missing_native', 'incomplete_requests', 'invalid_spans', 'rejected_batches', 'duplicate_completions']
const FLAGS = ['collection_truncated_raw', 'cli_exit_observed_raw', 'native_flush_confirmed_raw']
const DETAIL = {
  lookup_trace_by_ids: 'trace_id_hex observed_span_ids run_ids thread_ids task_ids',
  lookup_trace_count: 'trace_count',
  span_timeline: 'started_utc span_row_uuid span_id_hex parent_span_id_hex parent_presence service stage status_code run_id thread_id task_id session_id',
  trace_integrity: 'span_rows distinct_span_ids native_roots external_or_missing_parent_rows self_parent_rows run_ids task_ids session_ids',
  generation_receipts: `started_utc event_uuid span_id_hex parent_span_id_hex provider model operation harness timing_basis ttft_basis first_output_item_ms ${TOKENS.join(' ')} latency_ms ttft_ms cache_reporting_exclusive_raw ${LINKS.join(' ')}`,
  safe_native_logs: `emitted_utc log_uuid trace_id_hex span_id_hex has_matching_apm_span safe_body_shape body_code ${LINKS.join(' ')}`,
  capture_summary: 'signal observed_count',
  apm_generation_spans: `started_utc span_row_uuid span_id_hex parent_span_id_hex service stage provider model operation harness timing_basis ttft_basis first_output_item_ms ${TOKENS.join(' ')} model_latency_ms ttft_ms span_duration_ms ${LINKS.join(' ')}`,
  ai_capture_summary: 'generation_rows generation_event_ids generation_span_ids invalid_span_id_rows with_input_usage with_output_usage with_cache_read_usage with_cache_creation_usage with_latency with_ttft native_request_generations app_server_fallback_generations',
  native_generation_collection: `emitted_utc span_row_uuid collection_span_id_hex parent_span_id_hex run_id harness ${COUNTERS.join(' ')} ${FLAGS.join(' ')}`,
}
export const REQUIRED_COLUMNS = Object.fromEntries(Object.entries(DETAIL).map(([key, value]) => [key, value.split(' ')]))
const TABLES = Object.keys(DETAIL).filter(name => !['lookup_trace_by_ids', 'lookup_trace_count'].includes(name))
const AGGREGATES = new Set(['lookup_trace_count', 'trace_integrity', 'capture_summary', 'ai_capture_summary'])
const NOT_EVALUATED = ['tail_error_retention', 'source_correlation', 'replay_correlation', 'apm_session_links']
const GENERATION_STAGES = new Set(['mikka.ai.generation', 'daemon.ai.generation'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const present = (row, key) => Object.hasOwn(row, key)
const count = value => Number.isSafeInteger(value) && value >= 0
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const id = (value, regex) => typeof value === 'string' && regex.test(value) && !/^0+$/.test(value.replaceAll('-', ''))
const flag = value => [true, 1, '1', 'true'].includes(value) ? true : [false, 0, '0', 'false'].includes(value) ? false : null
const canonical = value => Array.isArray(value) ? value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const unique = (rows, field) => new Set(rows.map(row => row[field]))
const bucket = row => JSON.stringify([row.operation, row.model, row.harness])

export function reconcile(manifest) {
  const problems = [], limitations = [], checks = [], results = []
  const transport = { unknownPages: 0, reportedUntruncatedPages: 0, explicitlyTruncatedPages: 0, invalidDeclarations: 0 }
  const emit = (list, code, context = {}, extra = {}) => list.push({ code, ...context, ...extra })
  const problem = (code, context, extra) => emit(problems, code, context, extra)
  const limit = (code, context, extra) => emit(limitations, code, context, extra)
  const eq = (code, actual, expected, context = {}) => {
    const matched = actual === expected
    checks.push({ code, ...context, matched, actual, expected })
    if (!matched) problem(code, context)
  }
  const equalSets = (code, left, right, context) => {
    const leftOnly = [...left].filter(value => !right.has(value)).length, rightOnly = [...right].filter(value => !left.has(value)).length
    checks.push({ code, ...context, matched: leftOnly === 0 && rightOnly === 0, left: left.size, right: right.size, leftOnly, rightOnly })
    if (leftOnly || rightOnly) problem(code, context)
  }
  const finish = () => ({ schemaVersion: 1, status: problems.length ? 'incomplete' : 'sets_consistent',
    overallAcceptance: null, upstreamCompleteness: 'not_proven', scope: 'offline_metadata_set_reconciliation',
    transport: { rowsetTruncation: transport.explicitlyTruncatedPages ? 'truncated'
      : transport.unknownPages || transport.invalidDeclarations ? 'unknown' : transport.reportedUntruncatedPages ? 'reported_untruncated' : 'not_observed', ...transport },
    databaseEnumeration: { status: problems.length ? 'incomplete' : 'complete',
      scope: 'scoped_unique_identity_sets_at_stable_captured_database_snapshots',
      queriesEvaluated: Object.keys(DETAIL), queriesNotEvaluated: NOT_EVALUATED,
      logsPhysicalMultiplicity: 'not_proven', upstreamDelivery: 'not_proven' },
    problems, limitations, checks, traces: results })
  if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.projectId !== 670821 || !object(manifest.snapshots)) {
    problem('manifest_invalid'); return finish()
  }
  const window = manifest.window, ids = manifest.ids
  const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
    && Number.isFinite(Date.parse(value.replace(' ', 'T') + 'Z'))
  if (!Array.isArray(window) || window.length !== 2 || !window.every(utc) || window[0] >= window[1]
    || !object(ids) || !['run_id', 'thread_id', 'task_id'].every(key => ids[key] === '' || id(ids[key], UUID))
    || !['run_id', 'thread_id', 'task_id'].some(key => id(ids[key], UUID))) { problem('fixed_scope_invalid'); return finish() }
  limit('not_a_production_acceptance_decision')
  limit('replay_scouts_failure_retention_privacy_and_cost_accuracy_not_evaluated')
  limit('log_physical_multiplicity_not_proven_by_unique_uuid_count')
  const fingerprints = {}, snapshots = {}, physicalOwners = new Map()
  function rowsFor(table, name, snapshot, traceId) {
    const context = { snapshot, ...(traceId ? { traceId } : {}), table: name }
    const cluster = ['generation_receipts', 'ai_capture_summary'].includes(name) ? 'Default' : 'Logs'
    if (!object(table)) { problem('table_missing', context); return [] }
    if (table.cluster !== cluster) problem('cluster_mismatch', context)
    if (JSON.stringify(table.window) !== JSON.stringify(window) || (traceId ? table.traceId !== traceId : hash(table.ids ?? null) !== hash(ids))) problem('query_scope_mismatch', context)
    if (!Array.isArray(table.columns) || new Set(table.columns).size !== table.columns.length) problem('columns_invalid', context)
    for (const field of REQUIRED_COLUMNS[name]) if (!Array.isArray(table.columns) || !table.columns.includes(field)) problem('column_missing', context, { field })
    if (!Array.isArray(table.pages) || !table.pages.length) { problem('pages_missing', context); return [] }
    if (AGGREGATES.has(name) && table.pages.length !== 1) problem('aggregate_pages_invalid', context)
    const rows = []
    for (const [index, page] of table.pages.entries()) {
      if (!object(page) || !Array.isArray(page.rows)) { problem('page_invalid', context, { page: index }); continue }
      if (page.offset !== index * PAGE) problem('page_offset_gap', context, { page: index })
      if (page.truncated === null) transport.unknownPages++
      else if (page.truncated === false) transport.reportedUntruncatedPages++
      else if (page.truncated === true) transport.explicitlyTruncatedPages++
      else transport.invalidDeclarations++
      // An unknown transport declaration is not rewritten. Acceptance below
      // depends on independent counts/identity sets and stable full snapshots.
      if (page.truncated !== false && page.truncated !== null) problem('page_truncated_or_unknown', context, { page: index })
      if (page.returnedRows !== page.rows.length) problem('page_row_count_mismatch', context, { page: index })
      if (page.rows.length > PAGE || (index < table.pages.length - 1 && page.rows.length !== PAGE)) problem('page_length_invalid', context, { page: index })
      if (index === table.pages.length - 1 && page.rows.length >= PAGE) problem('terminal_page_missing', context)
      if (rows.length + page.rows.length > MAX_ROWS) { problem('local_row_budget_exceeded', context); break }
      for (const row of page.rows) {
        if (!object(row)) { problem('row_invalid', context); continue }
        for (const field of REQUIRED_COLUMNS[name]) if (!present(row, field)) problem('field_missing', context, { field })
        rows.push(row)
      }
    }
    const physical = name === 'lookup_trace_by_ids' ? 'trace_id_hex' : name === 'generation_receipts' ? 'event_uuid'
      : name === 'safe_native_logs' ? 'log_uuid' : ['span_timeline', 'apm_generation_spans', 'native_generation_collection'].includes(name) ? 'span_row_uuid' : null
    if (physical) {
      if (rows.some(row => !id(row[physical], physical === 'trace_id_hex' ? TRACE : UUID))) problem('row_identity_invalid', context)
      eq('physical_rows_unique', unique(rows, physical).size, rows.length, context)
      for (const row of rows) {
        const key = `${snapshot}:${name}:${row[physical]}`
        if (physicalOwners.has(key) && physicalOwners.get(key) !== traceId) problem('physical_uuid_reused_across_traces', context)
        physicalOwners.set(key, traceId)
      }
    }
    for (const row of rows) {
      for (const field of ['span_id_hex', 'collection_span_id_hex']) if (present(row, field) && !id(row[field], SPAN)) problem('span_identity_invalid', context, { field })
      if (present(row, 'parent_span_id_hex') && (typeof row.parent_span_id_hex !== 'string' || !SPAN.test(row.parent_span_id_hex))) problem('parent_identity_invalid', context)
      for (const field of LINKS) if (present(row, field) && row[field] !== null && !id(row[field], UUID)) problem('link_identity_invalid', context, { field })
      for (const field of ['model', 'provider', 'operation', 'harness', 'timing_basis', 'ttft_basis']) if (present(row, field) && row[field] !== null && (typeof row[field] !== 'string' || row[field].length > 256)) problem('metadata_type_invalid', context, { field })
      for (const field of ['started_utc', 'emitted_utc']) if (present(row, field) && !AGGREGATES.has(name)) {
        const time = Date.parse(row[field]), start = Date.parse(window[0].replace(' ', 'T') + 'Z'), end = Date.parse(window[1].replace(' ', 'T') + 'Z')
        if (!Number.isFinite(time) || time < start || time >= end) problem('row_outside_window', context, { field })
      }
    }
    fingerprints[`${snapshot}:${traceId ?? 'lookup'}:${name}`] = hash(rows)
    return rows
  }
  function summary(rows, name, context) {
    if (rows.length !== 1) { problem('summary_row_missing_or_multiple', context, { table: name }); return {} }
    return rows[0]
  }
  function countMatch(code, actual, expected, context, field) {
    if (!count(expected)) { problem('summary_count_unknown', context, { field }); return }
    eq(code, actual, expected, { ...context, field })
  }
  for (const snapshot of ['before', 'after']) {
    const state = manifest.snapshots[snapshot]
    if (!object(state)) { problem('snapshot_missing', { snapshot }); continue }
    if (typeof state.capturedAt !== 'string' || !state.capturedAt.endsWith('Z') || !Number.isFinite(Date.parse(state.capturedAt))) problem('snapshot_time_missing_or_invalid', { snapshot })
    const lookup = rowsFor(state.lookup, 'lookup_trace_by_ids', snapshot)
    const lookupSummary = summary(rowsFor(state.lookupCount, 'lookup_trace_count', snapshot), 'lookup_trace_count', { snapshot })
    const discovered = new Set(lookup.map(row => row.trace_id_hex).filter(value => id(value, TRACE)))
    countMatch('lookup_trace_count', discovered.size, lookupSummary.trace_count, { snapshot, table: 'lookup_trace_by_ids' }, 'trace_count')
    if (!discovered.size) problem('lookup_empty_no_evidence', { snapshot })
    const supplied = new Set(Object.keys(state.traces ?? {}).filter(value => id(value, TRACE)))
    equalSets('all_discovered_traces_supplied', discovered, supplied, { snapshot })
    const perTrace = new Map(); snapshots[snapshot] = { discovered, perTrace }
    for (const traceId of discovered) {
      const context = { snapshot, traceId }, source = state.traces?.[traceId] ?? {}, tables = {}
      for (const name of TABLES) tables[name] = rowsFor(source[name], name, snapshot, traceId)
      const timeline = tables.span_timeline, ai = tables.generation_receipts, apm = tables.apm_generation_spans, logs = tables.safe_native_logs, collection = tables.native_generation_collection
      const integrity = summary(tables.trace_integrity, 'trace_integrity', context), aiSummary = summary(tables.ai_capture_summary, 'ai_capture_summary', context)
      const spanIds = unique(timeline, 'span_id_hex'), aiIds = unique(ai, 'span_id_hex'), apmIds = unique(apm, 'span_id_hex')
      eq('timeline_logical_ids_unique', spanIds.size, timeline.length, context)
      countMatch('timeline_rows', timeline.length, integrity.span_rows, context, 'span_rows')
      countMatch('timeline_span_ids', spanIds.size, integrity.distinct_span_ids, context, 'distinct_span_ids')
      const lookedUp = lookup.find(row => row.trace_id_hex === traceId)
      // Lookup filters by run/thread/task IDs; ancestors in the full trace need not carry them.
      if (!count(lookedUp?.observed_span_ids) || lookedUp.observed_span_ids < 1 || lookedUp.observed_span_ids > spanIds.size) problem('lookup_span_count_invalid', context)
      for (const [field, link] of [['run_ids', 'run_id'], ['thread_ids', 'thread_id'], ['task_ids', 'task_id']]) {
        if (!Array.isArray(lookedUp?.[field]) || lookedUp[field].some(value => !id(value, UUID))) problem('lookup_identity_set_invalid', context, { field })
        else if (lookedUp[field].some(value => !timeline.some(row => row[link] === value))) problem('lookup_identity_missing_from_timeline', context, { field })
      }
      for (const [field, link] of [['run_ids', 'run_id'], ['task_ids', 'task_id'], ['session_ids', 'session_id']]) {
        if (!Array.isArray(integrity[field]) || integrity[field].some(value => !id(value, UUID))) problem('summary_identity_set_invalid', context, { field })
        else equalSets('integrity_identity_set', new Set(timeline.map(row => row[link]).filter(value => value !== null)), new Set(integrity[field]), { ...context, field })
      }
      for (const [field, actual] of Object.entries({ native_roots: timeline.filter(row => row.parent_presence === 'root').length,
        external_or_missing_parent_rows: timeline.filter(row => row.parent_presence === 'external_or_missing_parent').length,
        self_parent_rows: timeline.filter(row => row.span_id_hex === row.parent_span_id_hex).length })) countMatch('integrity_count', actual, integrity[field], context, field)
      if (integrity.self_parent_rows > 0) problem('self_parent_observed', context)
      if (integrity.external_or_missing_parent_rows > 0) limit('external_parents_require_execution_receipt', context, { count: integrity.external_or_missing_parent_rows })
      for (const [stage, detail] of [['generation', apm], ['collection', collection]]) {
        const selected = timeline.filter(row => stage === 'generation' ? GENERATION_STAGES.has(row.stage) : row.stage === 'daemon.ai.collection')
        equalSets('timeline_detail_logical_subset', unique(selected, 'span_id_hex'), unique(detail, stage === 'generation' ? 'span_id_hex' : 'collection_span_id_hex'), { ...context, group: stage })
        equalSets('timeline_detail_physical_subset', unique(selected, 'span_row_uuid'), unique(detail, 'span_row_uuid'), { ...context, group: stage })
        equalSets('timeline_detail_identity_pair', new Set(selected.map(row => JSON.stringify([row.span_id_hex, row.span_row_uuid]))), new Set(detail.map(row => JSON.stringify([row[stage === 'generation' ? 'span_id_hex' : 'collection_span_id_hex'], row.span_row_uuid]))), { ...context, group: stage })
        eq('timeline_detail_row_count', selected.length, detail.length, { ...context, group: stage })
      }
      for (const [field, actual] of Object.entries({ generation_rows: ai.length, generation_event_ids: unique(ai, 'event_uuid').size, generation_span_ids: aiIds.size })) countMatch('ai_summary_count', actual, aiSummary[field], context, field)
      eq('one_ai_event_per_span', ai.length, aiIds.size, context)
      eq('one_apm_row_per_generation_span', apm.length, apmIds.size, context)
      countMatch('ai_invalid_span_ids', ai.filter(row => !id(row.span_id_hex, SPAN)).length, aiSummary.invalid_span_id_rows, context, 'invalid_span_id_rows')
      const coverage = { with_input_usage: 'input_tokens', with_output_usage: 'output_tokens', with_cache_read_usage: 'cache_read_tokens', with_cache_creation_usage: 'cache_creation_tokens', with_latency: 'latency_ms', with_ttft: 'ttft_ms' }
      for (const [field, metric] of Object.entries(coverage)) countMatch('ai_numeric_coverage', ai.filter(row => number(row[metric])).length, aiSummary[field], context, field)
      for (const [field, basis] of [['native_request_generations', 'official_cli_trace'], ['app_server_fallback_generations', 'app_server_usage']]) countMatch('ai_timing_coverage', ai.filter(row => row.timing_basis === basis).length, aiSummary[field], context, field)
      equalSets('ai_apm_span_identity', aiIds, apmIds, context)
      const buckets = new Set([...ai, ...apm].map(bucket)), bucketCounts = []
      for (const key of buckets) {
        const left = ai.filter(row => bucket(row) === key), right = apm.filter(row => bucket(row) === key), bucketHash = createHash('sha256').update(key).digest('hex')
        equalSets('bucket_span_identity', unique(left, 'span_id_hex'), unique(right, 'span_id_hex'), { ...context, bucketHash })
        eq('bucket_row_count', left.length, right.length, { ...context, bucketHash })
        bucketCounts.push({ bucketHash, nullDimensions: JSON.parse(key).map(value => value === null), aiRows: left.length, aiEvents: unique(left, 'event_uuid').size, aiSpans: unique(left, 'span_id_hex').size, apmRows: right.length, apmPhysicalRows: unique(right, 'span_row_uuid').size, apmSpans: unique(right, 'span_id_hex').size })
      }
      const bySpan = new Map(apm.map(row => [row.span_id_hex, row]))
      for (const event of ai) {
        const span = bySpan.get(event.span_id_hex)
        if (!span) continue
        const c = { ...context, ...(id(event.span_id_hex, SPAN) ? { spanId: event.span_id_hex } : {}) }
        for (const field of ['parent_span_id_hex', 'model', ...LINKS, 'operation', 'harness', 'timing_basis', 'ttft_basis']) if (event[field] !== span[field]) problem('generation_metadata_mismatch', c, { field })
        if (typeof event.model !== 'string' || !event.model) problem('generation_model_missing', c)
        if (typeof event.provider !== 'string' || !event.provider) problem('generation_provider_missing', c)
        if (span.provider !== null && span.provider !== event.provider) problem('generation_metadata_mismatch', c, { field: 'provider' })
        if (span.provider === null) limit('apm_provider_unavailable', c)
        for (const [left, right] of [...TOKENS.map(field => [field, field]), ['latency_ms', 'model_latency_ms'], ['ttft_ms', 'ttft_ms'], ['first_output_item_ms', 'first_output_item_ms']]) {
          if (event[left] === null || span[right] === null) limit('generation_numeric_unknown', c, { field: left })
          if ((event[left] !== null && !number(event[left])) || (span[right] !== null && !number(span[right]))) problem('generation_numeric_invalid', c, { field: left })
          if (event[left] !== span[right] && !(number(event[left]) && number(span[right]) && !TOKENS.includes(left) && Math.abs(event[left] - span[right]) <= 1)) problem('generation_numeric_mismatch', c, { field: left })
        }
        if (flag(event.cache_reporting_exclusive_raw) !== false) limit('cache_semantics_not_inclusive_or_unknown', c)
        if (event.timing_basis === 'official_cli_trace') {
          if (!number(event.latency_ms) || !number(span.span_duration_ms) || Math.abs(event.latency_ms - span.span_duration_ms) > 1) problem('native_latency_interval_mismatch', c)
          if (event.ttft_ms !== null && (event.ttft_basis !== 'request_to_first_output_item' || event.ttft_ms !== event.first_output_item_ms || event.ttft_ms > event.latency_ms)) problem('native_ttft_basis_mismatch', c)
        }
      }
      const capture = tables.capture_summary
      eq('capture_fixed_cardinality', capture.length, 3, context)
      for (const signal of ['apm_span_ids', 'native_log_rows', 'unsafe_log_body_rows']) {
        const selected = capture.filter(row => row.signal === signal)
        if (selected.length !== 1) { problem('capture_signal_missing_or_multiple', context); continue }
        const actual = signal === 'apm_span_ids' ? spanIds.size : signal === 'native_log_rows' ? unique(logs, 'log_uuid').size : logs.filter(row => !['completed', 'failed'].includes(row.body_code)).length
        countMatch('capture_count', actual, selected[0].observed_count, context, signal)
        if (signal === 'unsafe_log_body_rows' && selected[0].observed_count !== 0) problem('unsafe_log_body_observed', context)
      }
      for (const row of logs) if (row.trace_id_hex !== traceId || !spanIds.has(row.span_id_hex) || flag(row.has_matching_apm_span) !== true || flag(row.safe_body_shape) !== true) problem('log_link_or_safe_shape_invalid', context)
      if (!timeline.length) problem('timeline_empty', context)
      if (!ai.length) limit('zero_generation_rows_not_acceptance', context)
      if (!logs.length) limit('zero_log_rows_not_acceptance', context)
      const daemon = apm.filter(row => row.stage === 'daemon.ai.generation'), nativeCounts = []
      if (collection.some(row => row.harness !== 'codex')) limit('collection_harness_not_supported', context)
      if ([...daemon, ...ai].some(row => row.harness === 'claude_code')) limit('claude_upstream_count_unavailable', context)
      const groups = new Set([...daemon, ...collection].filter(row => row.harness === 'codex').map(row => JSON.stringify([row.run_id, row.harness])))
      for (const key of groups) {
        const [runId, harness] = JSON.parse(key), c = { ...context, ...(id(runId, UUID) ? { runId } : {}), harness }
        if (!id(runId, UUID)) problem('native_run_identity_missing', c)
        const collected = collection.filter(row => row.run_id === runId && row.harness === harness)
        const distinct = [...new Map(collected.map(row => [row.collection_span_id_hex, row])).values()]
        const conflicting = distinct.some(row => new Set(collected.filter(value => value.collection_span_id_hex === row.collection_span_id_hex).map(value => hash(Object.fromEntries([...COUNTERS, ...FLAGS].map(field => [field, value[field]]))))).size > 1)
        if (!collected.length) problem('native_collection_missing', c)
        if (conflicting) problem('collection_duplicate_conflict', c)
        eq('collection_logical_ids_unique', distinct.length, collected.length, c)
        const totals = Object.fromEntries(COUNTERS.map(field => {
          const sum = !conflicting && distinct.length && distinct.every(row => count(row[field])) ? distinct.reduce((total, row) => total + row[field], 0) : null
          return [field, count(sum) ? sum : null]
        }))
        for (const field of COUNTERS) if (totals[field] === null) limit('native_counter_unknown', c, { field })
        for (const row of distinct) {
          if (flag(row.collection_truncated_raw) !== false) problem('native_collection_truncated_or_unknown', c)
          if (flag(row.cli_exit_observed_raw) !== true) limit('cli_exit_unconfirmed', c)
          if (flag(row.native_flush_confirmed_raw) !== true) limit('native_flush_unconfirmed', c)
        }
        for (const field of ['missing_native', 'incomplete_requests', 'invalid_spans', 'rejected_batches', 'duplicate_completions']) if (totals[field] > 0) limit('native_coverage_counter_nonzero', c, { field, count: totals[field] })
        const add = (left, right) => count(left) && count(right) && count(left + right) ? left + right : null
        const intended = add(totals.native_generations, totals.fallback_generations)
        const appServerReceipts = add(totals.matched_fallbacks, totals.fallback_generations)
        const apmRun = daemon.filter(row => row.run_id === runId && row.harness === harness), aiRun = ai.filter(row => row.run_id === runId && row.harness === harness)
        if (intended !== null) { eq('native_intended_apm', unique(apmRun, 'span_id_hex').size, intended, c); eq('native_intended_ai', unique(aiRun, 'span_id_hex').size, intended, c) }
        for (const [field, basis] of [['native_generations', 'official_cli_trace'], ['fallback_generations', 'app_server_usage']]) if (totals[field] !== null) {
          eq('native_basis_apm', apmRun.filter(row => row.timing_basis === basis).length, totals[field], { ...c, field })
          eq('native_basis_ai', aiRun.filter(row => row.timing_basis === basis).length, totals[field], { ...c, field })
        }
        limit('app_server_count_is_collection_receipt_not_independent_upstream_total', c)
        nativeCounts.push({ ...c, collectionSpans: distinct.length, ...totals, intendedEmissions: intended, observedAppServerReceipts: appServerReceipts })
      }
      perTrace.set(traceId, tables)
      results.push({ ...context, timelineRows: timeline.length, timelinePhysicalRows: unique(timeline, 'span_row_uuid').size, timelineSpanIds: spanIds.size,
        aiRows: ai.length, aiEventIds: unique(ai, 'event_uuid').size, aiSpanIds: aiIds.size, apmGenerationRows: apm.length, logRows: logs.length, logUuids: unique(logs, 'log_uuid').size, buckets: bucketCounts, nativeCounts })
    }
  }
  if (snapshots.before && snapshots.after) {
    if (!(Date.parse(manifest.snapshots.before.capturedAt) < Date.parse(manifest.snapshots.after.capturedAt))) problem('snapshot_time_order_invalid')
    equalSets('discovered_traces_stable', snapshots.before.discovered, snapshots.after.discovered, {})
    for (const key of Object.keys(fingerprints).filter(key => key.startsWith('before:'))) {
      const rest = key.slice(7), after = fingerprints['after:' + rest], parts = rest.split(':')
      const context = { ...(id(parts[0], TRACE) ? { traceId: parts[0] } : {}), table: parts[1] }
      if (!after || after !== fingerprints[key]) problem('snapshot_counts_or_identity_sets_unstable', context)
    }
  }
  return finish()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('usage')
    const bytes = await readFile(process.argv[2]); if (bytes.length > 64 * 1024 * 1024) throw new Error('size')
    const report = reconcile(JSON.parse(bytes.toString('utf8')))
    await writeFile(process.argv[3], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ status: report.status, overallAcceptance: null, problems: report.problems.length, limitations: report.limitations.length }))
    if (report.problems.length) process.exitCode = 1
  } catch { console.error(JSON.stringify({ status: 'not_reconciled', code: 'local_input_or_output_invalid', overallAcceptance: null })); process.exitCode = 2 }
}

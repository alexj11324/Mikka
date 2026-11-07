#!/usr/bin/env node
// Offline, fixed metadata SQL only. Successful parsing is not complete enumeration.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { REQUIRED_COLUMNS } from './reconcile-production-evidence.mjs'

const PAGE = 500, MAX_INPUT = 8 * 1024 * 1024, MAX_RESULTS = 2 * 1024 * 1024
const sha = value => createHash('sha256').update(value).digest('hex')
const templateBytes = readFileSync(new URL('./production-evidence-query-templates.json', import.meta.url))
const templates = JSON.parse(templateBytes.toString('utf8')).queries
// Hashes bind the reviewed column types to SQL, not to mutable template notes.
const SQL_HASHES = {
  lookup_trace_by_ids: '9508fdb7327e3688a12377021e821bf7d6dbd3acb85ef956207091d3136d8fdb',
  span_timeline: 'ea6a0f5e5a26dc82e9d44e2cf7707e316b89169265f49d52f79e871083c5d2b3',
  trace_integrity: 'f925cc10817c9903888b5d014d049bd70fa79aa29de29db259aaad0dd8a4036e',
  generation_receipts: '621c07e4b85df37f0793f4dce6786c5447a8612d9b9f120f6129b093dcc206a5',
  tail_error_retention: '93cadd4c63825a6c291f53e857a28de50695311137f0e533589415c80c70f727',
  safe_native_logs: '8008fa8570622dd8a11d26968fd72f0392fab91521dc774ed432e8de5efde394',
  source_correlation: 'a460dfed6c168ab732064df0ab1a9cc1fdadbf64077eee81a75bd632cf4fa8b3',
  replay_correlation: '07cbb3f5c660377a577aafd882d3e64436fd61d907656643bbf21a1b82b36304',
  capture_summary: '9b7d18e1e1596aef96ab253706b32d81ea25a89f9a74299b36e3c9d7522639e9',
  apm_generation_spans: '1d43fcc835476f143ba6c51c390a8cfbc5c522fc9a0c8184374046ec76050b40',
  ai_capture_summary: 'd0f778fb375bdebc0de8643d79f74d2a17ba9125581409be58c55645afaf47ec',
  apm_session_links: '6ac78767b11634edf38640c61fd37f5f34d393bcf44adbab9ea0cf109ffa1edb',
  native_generation_collection: '8de7a9e941869dc778ab5dd9bc61ac9a0484626d8d2e08518a2bbd17fc08bde4',
}
const SCHEMAS = {
  lookup_trace_by_ids: `trace_id_hex:trace started_utc:time ended_utc:time services:service[] observed_span_ids:int run_ids:id[] thread_ids:id[] task_ids:id[]`,
  span_timeline: `started_utc:time span_row_uuid:uuid offset_ms:num duration_ms:num service:service stage:stage workflow:label? workflow_step:label?
    span_id_hex:span parent_span_id_hex:span parent_stage:stage0? parent_presence:parent status_code:int run_id:id? thread_id:id? task_id:id? workflow_run_id:id? session_id:id?`,
  trace_integrity: `span_rows:int distinct_span_ids:int native_roots:int external_or_missing_parent_rows:int self_parent_rows:int services:service[]
    started_utc:time ended_utc:time elapsed_ms:num run_ids:id[] task_ids:id[] session_ids:id[]`,
  generation_receipts: `started_utc:time event_uuid:uuid span_id_hex:span parent_span_id_hex:span valid_span_id:bool provider:label? model:label? operation:label? harness:label?
    route:label? fallback_reason:label? zerocat_ms:num? tier:label? tier_score:num? tier_confidence:num? effort:label? effort_score:num? effort_confidence:num?
    timing_basis:label? ttft_basis:label? model_basis:label? native_unavailable_reason:label? first_output_item_ms:num?
    input_tokens:num? output_tokens:num? cache_read_tokens:num? cache_creation_tokens:num? cache_reporting_exclusive_raw:flag?
    latency_ms:num? ttft_ms:num? total_cost_usd:num? cost_passthrough_raw:flag? cost_model_source:label? cost_model_used:label? cost_model_provider:label?
    cost_basis:cost is_error:bool server_outcome:label? session_id:id? run_id:id? thread_id:id? task_id:id?`,
  tail_error_retention: `service:service span_rows:int span_ids:int error_span_rows:int http_failure_span_rows:int slow_span_rows:int tail_retained_span_rows:int
    critical_child_retained_rows:int full_rate_span_rows:int missing_rate_rows:int nonfull_rate_rows:int retention_reasons:label[]`,
  safe_native_logs: `emitted_utc:time log_uuid:uuid service:service severity_text:label body_code:body safe_body_shape:bool stage:stage? duration_ms:num?
    trace_id_hex:trace span_id_hex:span has_matching_apm_span:bool run_id:id? thread_id:id? task_id:id? session_id:id? error_code:label? error_type:label?`,
  source_correlation: `service:service service_version:version span_rows:int span_ids:int client_kinds:label[] run_ids:id[] thread_ids:id[] task_ids:id[] workflow_run_ids:id[] session_ids:id[]`,
  replay_correlation: `session_id:id recording_chunks:int recorded_bytes:int replay_events:int recording_started_utc:time? recording_ended_utc:time? deleted:bool?
    console_logs:int? console_warnings:int? console_errors:int? correlated_generations:int`,
  capture_summary: `signal:signal observed_count:int`,
  apm_generation_spans: `started_utc:time span_row_uuid:uuid service:service stage:stage span_id_hex:span parent_span_id_hex:span model:label0 provider:label? outcome:label?
    operation:label? harness:label? route:label? fallback_reason:label? zerocat_ms:num? tier:label? tier_score:num? tier_confidence:num? effort:label? effort_score:num? effort_confidence:num?
    timing_basis:label? ttft_basis:label? model_basis:label? native_unavailable_reason:label? first_output_item_ms:num? sample_rate:num? run_id:id? thread_id:id? task_id:id?
    span_duration_ms:num model_latency_ms:num? ttft_ms:num? input_tokens:num? output_tokens:num? cache_read_tokens:num? cache_creation_tokens:num? captured_cost_usd:num? session_id:id?`,
  ai_capture_summary: `generation_rows:int generation_event_ids:int generation_span_ids:int invalid_span_id_rows:int with_input_usage:int with_output_usage:int with_cache_read_usage:int with_cache_creation_usage:int
    cache_inclusive_rows:int cache_exclusive_rows:int cache_semantics_unknown_rows:int with_latency:int with_ttft:int native_request_generations:int app_server_fallback_generations:int
    ttft_bases:label[] native_unavailable_reasons:label[] captured_per_call_cost_rows:int catalog_api_estimate_rows:int custom_api_estimate_rows:int unverified_cost_provenance_rows:int
    cost_passthrough_values:flag[] cost_model_sources:label[] cost_models_used:label[] cost_model_providers:label[] unknown_cost_rows:int`,
  apm_session_links: `session_id:id service:service correlated_span_ids:int run_ids:id[] task_ids:id[]`,
  native_generation_collection: `emitted_utc:time span_row_uuid:uuid collection_span_id_hex:span parent_span_id_hex:span run_id:id? thread_id:id? task_id:id? workflow_run_id:id? session_id:id?
    harness:label? native_unavailable_reason:label? sample_rate:num? native_generations:num? fallback_generations:num? matched_fallbacks:num? missing_native:num? incomplete_requests:num?
    invalid_spans:num? rejected_batches:num? duplicate_completions:num? collection_truncated_raw:flag? cli_exit_observed_raw:flag? native_flush_confirmed_raw:flag?`,
}
const ENUMS = {
  service: ['mikka-web', 'mikka-daemon'], parent: ['root', 'observed_parent', 'external_or_missing_parent'],
  body: ['completed', 'failed', 'unexpected_body_redacted'], flag: ['false', 'true', '0', '1'],
  signal: ['apm_span_ids', 'native_log_rows', 'unsafe_log_body_rows'],
  cost: ['unknown', 'captured_per_call_amount', 'catalog_api_equivalent_estimate', 'custom_api_equivalent_estimate', 'amount_with_unverified_provenance'],
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const STAGE = /^[A-Za-z0-9][A-Za-z0-9 ._:/[\]{}()-]{0,255}$/
const DENIED = /https?:\/\/|(?:^|[\s/:])(?:ph[cx]_|sk[-_]|gh[pousr]_|github_pat_)|@|\.\.\.|…|\(empty\)|\b(?:truncated|omitted)\b/i
const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/
export const QUERY_NAMES = Object.freeze(Object.keys(SCHEMAS))

export class NormalizationError extends Error {
  constructor(code) { super(code); this.name = 'NormalizationError'; this.code = code }
}
const fail = code => { throw new NormalizationError(code) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function exactKeys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('response_shape_invalid')
}

// JSON.parse alone accepts duplicate keys. Scan the syntax tree first so a
// conflicting query/results/truncation field cannot be hidden by the last key.
function strictJson(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_INPUT) fail('input_size_or_type_invalid')
  let value
  try { value = JSON.parse(text) } catch { fail('json_invalid') }
  const tokens = text.match(/"(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]/g)
  let cursor = 0
  const visit = depth => {
    if (depth > 12) fail('json_depth_exceeded')
    const token = tokens[cursor++]
    if (token !== '{' && token !== '[') return
    const close = token === '{' ? '}' : ']', keys = new Set()
    while (tokens[cursor] !== close) {
      if (token === '{') {
        const key = JSON.parse(tokens[cursor++]); cursor++
        if (keys.has(key)) fail('json_duplicate_key')
        keys.add(key)
      }
      visit(depth + 1)
      if (tokens[cursor] === ',') cursor++
    }
    cursor++
  }
  visit(0)
  return value
}

export function columnsForQuery(name) {
  if (!Object.hasOwn(SCHEMAS, name)) fail('query_name_invalid')
  return SCHEMAS[name].trim().split(/\s+/).map(value => {
    const [name, type] = value.split(':'); return { name, type }
  })
}
function utc(value, window = false) {
  const regex = window ? /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/ : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/
  const iso = window ? value.replace(' ', 'T') + 'Z' : value, time = Date.parse(iso)
  return regex.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 19) === iso.slice(0, 19)
}
function scalar(value, type) {
  if (typeof value !== 'string' || DENIED.test(value)) fail('cell_format_invalid')
  if (ENUMS[type]) { if (!ENUMS[type].includes(value)) fail('cell_enum_invalid'); return value }
  if (type === 'bool') {
    if (value === 'true' || value === 'false') return value === 'true'
    // Preserve the numeric 0/1 spelling; do not pretend the server sent a bool.
    if (value === '0' || value === '1') return Number(value)
    fail('cell_boolean_invalid')
  }
  if (type === 'num' || type === 'int') {
    const number = Number(value)
    if (!NUMERIC.test(value) || !Number.isFinite(number) || Object.is(number, -0) || Math.abs(number) > Number.MAX_SAFE_INTEGER ||
      (number === 0 && /[1-9]/.test(value.split(/[eE]/)[0])) ||
      (type === 'int' && (!/^\d+$/.test(value) || !Number.isSafeInteger(number)))) fail('cell_number_invalid')
    return number
  }
  const valid = type === 'time' ? utc(value) : type === 'uuid' ? UUID.test(value)
    : type === 'trace' ? /^[0-9a-f]{32}$/.test(value) : type === 'span' ? /^[0-9a-f]{16}$/.test(value)
    : type === 'id' ? ID.test(value) : type === 'version' ? value === '(not stamped)' || LABEL.test(value)
    : type === 'label0' ? value === '' || LABEL.test(value) : type === 'stage0' ? value === '' || STAGE.test(value)
    : type === 'label' ? LABEL.test(value) : type === 'stage' ? STAGE.test(value) : false
  if (!valid) fail('cell_format_invalid')
  return value
}
function hasControl(value, allowLf = false) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 32 && !(allowLf && code === 10)) || code === 127) return true
  }
  return false
}
function cell(value, type) {
  if (Buffer.byteLength(value) > 8192 || hasControl(value)) fail('cell_size_or_control_invalid')
  const nullable = type.endsWith('?'), base = nullable ? type.slice(0, -1) : type
  if (value === '(null)') { if (!nullable) fail('cell_unexpected_null'); return null }
  if (base.endsWith('[]')) {
    const values = strictJson(value)
    if (!Array.isArray(values) || values.length > PAGE) fail('cell_array_invalid')
    return values.map(item => scalar(item, base.slice(0, -2)))
  }
  return scalar(value, base)
}
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function bindQuery(name, sql) {
  const template = templates[name], expectedHash = SQL_HASHES[name]
  if (!expectedHash || typeof template !== 'string' || sha(template) !== expectedHash) fail('query_contract_changed')
  const fields = [], patterns = {
    window_start_utc: '\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d', window_end_utc: '\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d',
    trace_id_hex: '[0-9a-f]{32}', row_offset: '(?:0|[1-9]\\d*)',
    run_id: '[A-Za-z0-9_-]{0,128}', thread_id: '[A-Za-z0-9_-]{0,128}', task_id: '[A-Za-z0-9_-]{0,128}', session_id: '[A-Za-z0-9_-]{1,128}',
  }
  let expression = '^', end = 0
  for (const match of template.matchAll(/\{\{([a-z_]+)\}\}/g)) {
    if (!patterns[match[1]]) fail('query_contract_changed')
    expression += escapeRegex(template.slice(end, match.index)) + '(' + patterns[match[1]] + ')'
    fields.push(match[1]); end = match.index + match[0].length
  }
  const match = new RegExp(expression + escapeRegex(template.slice(end)) + '$').exec(sql)
  if (!match || match[0] !== sql) fail('query_text_mismatch')
  const scope = {}
  fields.forEach((field, index) => {
    const value = match[index + 1]
    if (Object.hasOwn(scope, field) && scope[field] !== value) fail('query_scope_conflict')
    scope[field] = value
  })
  if (!utc(scope.window_start_utc, true) || !utc(scope.window_end_utc, true) || scope.window_start_utc >= scope.window_end_utc ||
    scope.trace_id_hex === '0'.repeat(32)) fail('query_scope_invalid')
  for (const key of ['run_id', 'thread_id', 'task_id', 'session_id']) if (scope[key]) scalar(scope[key], 'id')
  const paginated = Object.hasOwn(scope, 'row_offset'), offset = paginated ? Number(scope.row_offset) : 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % PAGE) fail('query_offset_invalid')
  return { scope, offset, paginated, templateHash: expectedHash }
}

/** Accept only the raw JSON encoding of one MCP result. No network, queries,
 * content fields, inferred columns, or asserted completeness are produced. */
export function normalizePosthogMetadata(name, rawResponseText, { requestText } = {}) {
  const schema = columnsForQuery(name)
  const response = strictJson(rawResponseText)
  exactKeys(response, ['content', 'structuredContent', 'isError'])
  if (response.isError !== false || response.structuredContent !== null || !Array.isArray(response.content) || response.content.length !== 1) fail('response_shape_invalid')
  const content = response.content[0]; exactKeys(content, ['type', 'text'])
  if (content.type !== 'text' || typeof content.text !== 'string') fail('response_shape_invalid')
  const inner = strictJson(content.text)
  exactKeys(inner, ['query', 'results', '__formatted_results_override'])
  exactKeys(inner.query, ['kind', 'query'])
  if (inner.query.kind !== 'HogQLQuery' || typeof inner.query.query !== 'string' || typeof inner.results !== 'string') fail('response_shape_invalid')
  if (inner.results !== inner.__formatted_results_override) fail('formatted_override_mismatch')
  const binding = bindQuery(name, inner.query.query)
  let requestTruncate = null
  if (requestText !== undefined) {
    const request = strictJson(requestText)
    exactKeys(request, ['query'], ['truncate', 'context'])
    if (request.query !== inner.query.query || (Object.hasOwn(request, 'truncate') && typeof request.truncate !== 'boolean') ||
      (Object.hasOwn(request, 'context') && typeof request.context !== 'string')) fail('request_response_mismatch')
    requestTruncate = request.truncate ?? null
  }
  const text = inner.results
  if (!text || Buffer.byteLength(text) > MAX_RESULTS || hasControl(text, true)) fail('results_format_invalid')
  const lines = text.split('\n'), columns = lines.shift().split('|')
  if (columns.length !== schema.length || columns.some((name, index) => name !== schema[index].name)) fail('columns_mismatch')
  for (const required of REQUIRED_COLUMNS[name] ?? []) if (!columns.includes(required)) fail('required_column_missing')
  if (lines.length > PAGE) fail('page_row_limit_exceeded')
  const rows = lines.map(line => {
    const cells = line.split('|')
    if (cells.length !== columns.length) fail('row_column_count_mismatch')
    return Object.fromEntries(cells.map((value, index) => [columns[index], cell(value, schema[index].type)]))
  })
  const cluster = ['generation_receipts', 'replay_correlation', 'ai_capture_summary'].includes(name) ? 'Default' : 'Logs'
  const { scope, paginated, offset } = binding
  return {
    schemaVersion: 1, status: 'normalized_metadata_only', acceptanceEvidence: false, upstreamCompleteness: 'not_proven', projectId: 670821, queryName: name,
    cluster, clusterSource: 'reviewed_query_contract_not_server_attestation', window: [scope.window_start_utc, scope.window_end_utc],
    ...(scope.trace_id_hex ? { traceId: scope.trace_id_hex } : { ids: { run_id: scope.run_id, thread_id: scope.thread_id, task_id: scope.task_id } }),
    ...(scope.session_id ? { sessionId: scope.session_id } : {}), columns, columnTypes: schema, columnTypesSource: 'reviewed_sql_not_server_type_metadata',
    pages: [{ offset, offsetSource: paginated ? 'exact_executed_sql_offset' : 'unpaginated_query', returnedRows: rows.length,
      returnedRowsSource: 'counted_complete_parsed_lines_not_server_total', truncated: null, truncationSource: 'not_reported_by_response',
      queryLimit: paginated ? PAGE : null, atQueryLimit: paginated && rows.length === PAGE, rows }],
    source: { rawResponseInputSha256: sha(rawResponseText), contentTextSha256: sha(content.text), formattedResultsSha256: sha(text), formattedOverrideMatched: true,
      executedQuerySha256: sha(inner.query.query), queryTemplateSha256: binding.templateHash, templateFileSha256: sha(templateBytes),
      requestInputSha256: requestText === undefined ? null : sha(requestText), requestTruncate,
      requestTruncateSource: requestText === undefined ? 'request_not_saved' : Object.hasOwn(strictJson(requestText), 'truncate') ? 'explicit_request_parameter' : 'request_parameter_omitted',
      requestTruncateScope: 'large_blob_or_json_cell_values_not_row_completeness' },
  }
}

function readUtf8(path) {
  const bytes = readFileSync(path)
  if (bytes.length > MAX_INPUT) fail('input_size_or_type_invalid')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { fail('input_encoding_invalid') }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), flags = {}
    for (let index = 0; index < args.length; index += 2) {
      if (!['--query', '--input', '--output', '--request'].includes(args[index]) || !args[index + 1] || Object.hasOwn(flags, args[index])) fail('cli_arguments_invalid')
      flags[args[index]] = args[index + 1]
    }
    if (!flags['--query'] || !flags['--input'] || !flags['--output']) fail('cli_arguments_invalid')
    const report = normalizePosthogMetadata(flags['--query'], readUtf8(flags['--input']),
      flags['--request'] ? { requestText: readUtf8(flags['--request']) } : {})
    writeFileSync(flags['--output'], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ status: report.status, queryName: report.queryName, columns: report.columns.length, rows: report.pages[0].returnedRows,
      truncated: null, acceptanceEvidence: false }))
  } catch (error) {
    console.error(JSON.stringify({ status: 'not_normalized', code: error instanceof NormalizationError ? error.code : 'local_input_or_output_invalid', acceptanceEvidence: false }))
    process.exitCode = 2
  }
}

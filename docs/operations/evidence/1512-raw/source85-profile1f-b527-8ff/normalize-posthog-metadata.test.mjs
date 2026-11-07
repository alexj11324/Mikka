import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { columnsForQuery, normalizePosthogMetadata, NormalizationError, QUERY_NAMES } from './normalize-posthog-metadata.mjs'
import { reconcile, REQUIRED_COLUMNS } from './reconcile-production-evidence.mjs'

const file = new URL('./evidence/posthog-pagination-schema-191fcce2.json', import.meta.url)
const original = readFileSync(file), saved = JSON.parse(original)
const templates = JSON.parse(readFileSync(new URL('./production-evidence-query-templates.json', import.meta.url), 'utf8')).queries
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const uuid = '00000000-0000-4000-8000-000000000001', span = '0123456789abcdef'
const parameters = { window_start_utc: '2026-11-06 20:00:00', window_end_utc: '2026-11-06 20:10:00',
  trace_id_hex: '77cad3a99b9e154b27aaa2c6c0226283', run_id: uuid, thread_id: '', task_id: '', session_id: uuid, row_offset: 0 }
const encode = value => value === null ? '(null)' : Array.isArray(value) ? JSON.stringify(value) : String(value)
function fixture(name, rows = [], params = {}) {
  const columns = columnsForQuery(name).map(value => value.name)
  const query = templates[name].replace(/\{\{([a-z_]+)\}\}/g, (_, key) => ({ ...parameters, ...params })[key])
  const results = [columns.join('|'), ...rows.map(row => columns.map(column => encode(row[column])).join('|'))].join('\n')
  return { content: [{ type: 'text', text: JSON.stringify({ query: { kind: 'HogQLQuery', query }, results, __formatted_results_override: results }) }], structuredContent: null, isError: false }
}
function rewrite(raw, change) {
  const value = structuredClone(raw), inner = JSON.parse(value.content[0].text)
  change(inner); value.content[0].text = JSON.stringify(inner); return value
}
const normalize = (name, raw, options) => normalizePosthogMetadata(name, JSON.stringify(raw), options)
const rejected = work => assert.throws(work, error => error instanceof NormalizationError && /^[a-z_]+$/.test(error.code))
function sample(name, values = {}) {
  const primitives = { time: '2026-11-06T20:07:18.395000Z', uuid, id: uuid, trace: parameters.trace_id_hex, span,
    label: 'agent', label0: '', stage: 'daemon.ai.generation', stage0: '', version: '(not stamped)', service: 'mikka-web',
    parent: 'root', body: 'completed', flag: 'false', bool: false, cost: 'unknown', signal: 'apm_span_ids', int: 0, num: 0 }
  return { ...Object.fromEntries(columnsForQuery(name).map(({ name, type }) => [name, type.endsWith('?') ? null : type.endsWith('[]') ? [] : primitives[type]])), ...values }
}

test('the five saved real MCP responses parse with actual columns and unknown completeness', () => {
  assert.equal(digest(original), '073282f96a6da1a1a49b0c1d4fdf05441038672b44e9d0a336197e3e95fe4d74')
  for (const query of saved.queries) {
    const result = normalize(query.name, query.raw_response), page = result.pages[0]
    assert.equal(page.returnedRows, query.returned_rows)
    assert.equal(result.columns.length, query.column_count)
    assert.deepEqual(result.columns, JSON.parse(query.raw_response.content[0].text).results.split('\n')[0].split('|'))
    assert.equal(page.offset, 0); assert.equal(page.truncated, null)
    assert.equal(result.source.requestTruncate, null); assert.equal(result.source.requestTruncateSource, 'request_not_saved')
    assert.equal(result.acceptanceEvidence, false); assert.equal(result.upstreamCompleteness, 'not_proven')
  }
  const timeline = normalize('span_timeline', saved.queries[1].raw_response).pages[0].rows
  assert.equal(timeline.length, 27)
  assert.equal(timeline[0].offset_ms, 0)
  assert.equal(timeline[0].workflow, null)
  assert.equal(timeline[0].parent_stage, '')
  assert.equal(timeline[0].span_row_uuid, '01a1b279-07a2-7670-9f04-75060cf74617')
})

test('only the fourteen fixed SQL contracts are accepted; columns are never fabricated for empty results', () => {
  const counts = [8, 18, 12, 42, 12, 17, 10, 11, 2, 38, 26, 5, 23, 1]
  assert.equal(QUERY_NAMES.length, 14)
  QUERY_NAMES.forEach((name, index) => {
    const result = normalize(name, fixture(name))
    assert.equal(result.columns.length, counts[index]); assert.deepEqual(result.pages[0].rows, [])
    for (const required of REQUIRED_COLUMNS[name] ?? []) assert.ok(result.columns.includes(required))
    assert.equal(result.cluster, ['generation_receipts', 'replay_correlation', 'ai_capture_summary'].includes(name) ? 'Default' : 'Logs')
    assert.equal(result.clusterSource, 'reviewed_query_contract_not_server_attestation')
  })
  rejected(() => normalize('raw_events', fixture('span_timeline')))
  for (const results of ['', '(empty)', 'No results', '[]']) rejected(() => normalize('span_timeline', rewrite(fixture('span_timeline'), inner => {
    inner.results = inner.__formatted_results_override = results
  })))
})

test('independent lookup count preserves the exact original group predicate and a closed nonnegative integer without claiming transport completeness', () => {
  const originalTemplates = JSON.parse(readFileSync(new URL('./evidence/posthog-enumeration-v1-01afbc76/production-evidence-query-templates.json', import.meta.url), 'utf8')).queries
  assert.equal(Object.keys(originalTemplates).length, 13)
  for (const [name, sql] of Object.entries(originalTemplates)) assert.equal(templates[name], sql)
  const originalLookup = originalTemplates.lookup_trace_by_ids
  const relation = originalLookup.slice(originalLookup.indexOf('FROM posthog.trace_spans'), originalLookup.indexOf('\nGROUP BY trace_id'))
  assert.ok(templates.lookup_trace_count.includes(relation.split('\n').map(line => '    ' + line).join('\n')))
  assert.match(templates.lookup_trace_count, /^SELECT count\(\) AS trace_count\nFROM \(\n    SELECT trace_id/)
  assert.match(templates.lookup_trace_count, /GROUP BY trace_id\n\) AS matched_traces$/)
  assert.doesNotMatch(templates.lookup_trace_count, /LIMIT|OFFSET|\{\{row_offset\}\}/)
  const raw = fixture('lookup_trace_count', [{ trace_count: 2 }])
  const query = JSON.parse(raw.content[0].text).query.query
  const result = normalize('lookup_trace_count', raw, { requestText: JSON.stringify({ query, truncate: false }) })
  assert.deepEqual(result.columns, ['trace_count'])
  assert.deepEqual(result.pages[0].rows, [{ trace_count: 2 }])
  assert.equal(result.pages[0].truncated, null)
  assert.equal(result.pages[0].queryLimit, null)
  assert.deepEqual(result.ids, { run_id: uuid, thread_id: '', task_id: '' })
  for (const trace_count of [null, -1, 0.5, '9007199254740993']) rejected(() => normalize('lookup_trace_count', fixture('lookup_trace_count', [{ trace_count }])))
  rejected(() => normalize('lookup_trace_count', rewrite(raw, inner => { inner.query.query += ' LIMIT 1' })))
})

test('typed arrays retain order and UUID bytes; null, zero, booleans and raw string flags remain distinct', () => {
  const integrity = sample('trace_integrity', { services: ['mikka-daemon', 'mikka-web'], run_ids: [uuid], task_ids: [], elapsed_ms: 1.25 })
  assert.deepEqual(normalize('trace_integrity', fixture('trace_integrity', [integrity])).pages[0].rows[0], integrity)
  const event = sample('generation_receipts', { model: 'claude-haiku-5-5', provider: 'anthropic', valid_span_id: 1, is_error: false,
    input_tokens: null, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: null, ttft_ms: 0, total_cost_usd: 0,
    cache_reporting_exclusive_raw: '0', cost_passthrough_raw: 'false', cost_model_used: 'anthropic/claude-haiku-5.5' })
  assert.deepEqual(normalize('generation_receipts', fixture('generation_receipts', [event])).pages[0].rows[0], event)
  const replay = sample('replay_correlation', { console_logs: 0, console_errors: null, deleted: null })
  assert.deepEqual(normalize('replay_correlation', fixture('replay_correlation', [replay])).pages[0].rows[0], replay)
})

test('the log projection contains only closed body codes, including explicit unsafe-body evidence', () => {
  for (const body_code of ['completed', 'failed', 'unexpected_body_redacted']) {
    const row = sample('safe_native_logs', { body_code, safe_body_shape: body_code !== 'unexpected_body_redacted' })
    assert.deepEqual(normalize('safe_native_logs', fixture('safe_native_logs', [row])).pages[0].rows[0], row)
  }
  rejected(() => normalize('safe_native_logs', fixture('safe_native_logs', [sample('safe_native_logs', { body_code: 'mikka.stage.completed' })])))
})

test('SQL offsets and parsed row counts are receipts, never an inferred terminal or untruncated page', () => {
  const result = normalize('span_timeline', fixture('span_timeline', Array.from({ length: 500 }, () => sample('span_timeline')), { row_offset: 500 }))
  assert.equal(result.pages[0].offset, 500); assert.equal(result.pages[0].returnedRows, 500)
  assert.equal(result.pages[0].atQueryLimit, true); assert.equal(result.pages[0].truncated, null)
  rejected(() => normalize('span_timeline', fixture('span_timeline', Array.from({ length: 501 }, () => sample('span_timeline')))))
  for (const row_offset of [1, -500, '0e3', '9007199254741500']) rejected(() => normalize('span_timeline', fixture('span_timeline', [], { row_offset })))
})

test('incomplete JSON, duplicate JSON keys, unrecognized envelopes and a conflicting override are rejected', () => {
  const raw = fixture('span_timeline'), text = JSON.stringify(raw)
  rejected(() => normalizePosthogMetadata('span_timeline', text.slice(0, -1)))
  rejected(() => normalizePosthogMetadata('span_timeline', text.replace('"isError":false', '"isError":true,"isError":false')))
  const duplicated = structuredClone(raw)
  duplicated.content[0].text = duplicated.content[0].text.replace('"results":', '"results":"", "resu\\u006cts":')
  rejected(() => normalize('span_timeline', duplicated))
  for (const patch of [{ isError: true }, { truncated: true }, { structuredContent: { rows: [] } }, { content: [...raw.content, ...raw.content] }]) rejected(() => normalize('span_timeline', { ...raw, ...patch }))
  rejected(() => normalize('span_timeline', rewrite(raw, inner => { inner.__formatted_results_override += '\n' })))
})

test('column count, header, multi-pipe cells, footers, line breaks and truncation markers fail closed', () => {
  const raw = fixture('span_timeline', [sample('span_timeline')])
  for (const change of [text => text + '|extra', text => text + '\n', text => text + '\n... truncated', text => text.replace('span_row_uuid', 'raw_payload'),
    text => text.replace('span_row_uuid', 'started_utc'), text => text.replace('daemon.ai.generation', 'daemon|ai'), text => text.replace('daemon.ai.generation', 'daemon\nai')]) {
    rejected(() => normalize('span_timeline', rewrite(raw, inner => { inner.results = inner.__formatted_results_override = change(inner.results) })))
  }
})

test('numeric and null ambiguity cannot silently become zero or a missing value', () => {
  for (const observed_count of ['', null, '(empty)', 'NaN', 'Infinity', '1x', '01', '-0', '9007199254740993']) {
    rejected(() => normalize('capture_summary', fixture('capture_summary', [sample('capture_summary', { observed_count })])))
  }
  for (const is_error of ['False', '', '(empty)', 2]) rejected(() => normalize('generation_receipts', fixture('generation_receipts', [sample('generation_receipts', { is_error })])))
  rejected(() => normalize('generation_receipts', fixture('generation_receipts', [sample('generation_receipts', { total_cost_usd: '1e-400' })])))
  const raw = fixture('trace_integrity', [sample('trace_integrity', { services: ['mikka-web'] })])
  for (const array of ["['mikka-web']", '(empty)', '{"service":"mikka-web"}', '[null]', '[true]', '[0]', '[["mikka-web"]]']) rejected(() => normalize('trace_integrity', rewrite(raw, inner => {
    inner.results = inner.__formatted_results_override = inner.results.replace('["mikka-web"]', array)
  })))
})

test('the matched query and request cannot widen the scope, cross clusters or smuggle a payload column', () => {
  const raw = fixture('span_timeline')
  for (const change of [sql => sql + '\n', sql => sql.replace('posthog.trace_spans', 'events'), sql => sql.replace('AS stage', 'AS raw_payload'),
    sql => sql.replace('2026-11-06 20:00:00', '2026-02-30 20:00:00')]) rejected(() => normalize('span_timeline', rewrite(raw, inner => { inner.query.query = change(inner.query.query) })))
  const lookup = fixture('lookup_trace_by_ids')
  rejected(() => normalize('lookup_trace_by_ids', rewrite(lookup, inner => { inner.query.query = inner.query.query.replace(uuid, '00000000-0000-4000-8000-000000000002') })))
  const query = JSON.parse(raw.content[0].text).query.query
  const declared = normalize('span_timeline', raw, { requestText: JSON.stringify({ query, truncate: false, context: 'SYNTHETIC_PRIVATE_CONTEXT' }) })
  assert.equal(declared.source.requestTruncate, false); assert.equal(declared.source.requestTruncateSource, 'explicit_request_parameter')
  assert.equal(declared.pages[0].truncated, null)
  assert.equal(JSON.stringify(declared).includes('SYNTHETIC_PRIVATE_CONTEXT'), false)
  for (const request of [{ query: query + ' ', truncate: false }, { query, truncate: 'false' }, { query, connectionId: 'another-source' }]) rejected(() => normalize('span_timeline', raw, { requestText: JSON.stringify(request) }))
})

test('metadata projection rejects private payload shapes and prints no supplied value in its errors', () => {
  for (const model of ['sk-testcredential', 'https://secret.invalid', 'person@example.invalid', 'private prompt with words', 'gpt-6-luna\u0000', 'x'.repeat(8193)]) {
    let error
    try { normalize('generation_receipts', fixture('generation_receipts', [sample('generation_receipts', { model })])) } catch (caught) { error = caught }
    assert.ok(error instanceof NormalizationError)
    assert.equal(error.message.includes(model), false)
  }
})

test('unknown response truncation does not supply a missing independent count or turn an empty lookup into evidence', () => {
  const lookup = normalize('lookup_trace_by_ids', fixture('lookup_trace_by_ids'))
  const manifest = { schemaVersion: 1, projectId: 670821, window: lookup.window, ids: lookup.ids,
    snapshots: { before: { capturedAt: '2026-11-06T20:11:00Z', lookup, traces: {} }, after: { capturedAt: '2026-11-06T20:12:00Z', lookup, traces: {} } } }
  const result = reconcile(manifest)
  assert.equal(result.status, 'incomplete'); assert.equal(result.overallAcceptance, null)
  assert.equal(result.transport.rowsetTruncation, 'unknown')
  assert.equal(result.databaseEnumeration.status, 'incomplete')
  assert.ok(result.problems.some(value => value.code === 'table_missing' && value.table === 'lookup_trace_count'))
  assert.ok(result.problems.some(value => value.code === 'lookup_empty_no_evidence'))
})

test('CLI writes a private non-overwriting receipt and emits only closed summaries on failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-posthog-normalizer-')), input = join(root, 'input.json'), output = join(root, 'page.json')
  const command = new URL('./normalize-posthog-metadata.mjs', import.meta.url).pathname
  try {
    writeFileSync(input, JSON.stringify(fixture('capture_summary', [{ signal: 'apm_span_ids', observed_count: 0 }])))
    const args = [command, '--query', 'capture_summary', '--input', input, '--output', output]
    const success = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 })
    assert.equal(success.status, 0); assert.equal(statSync(output).mode & 0o777, 0o600)
    const bytes = readFileSync(output)
    assert.equal(JSON.parse(bytes).pages[0].truncated, null)
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 5000 }).status, 2)
    assert.deepEqual(readFileSync(output), bytes)
    const badOutput = join(root, 'bad.json')
    writeFileSync(input, '{"private":"SYNTHETIC_SECRET"')
    const failure = spawnSync(process.execPath, [command, '--query', 'capture_summary', '--input', input, '--output', badOutput], { encoding: 'utf8', timeout: 5000 })
    assert.equal(failure.status, 2); assert.equal(existsSync(badOutput), false)
    assert.deepEqual(JSON.parse(failure.stderr), { status: 'not_normalized', code: 'json_invalid', acceptanceEvidence: false })
    assert.equal((failure.stdout + failure.stderr).includes('SYNTHETIC_SECRET'), false)
    writeFileSync(input, Buffer.from([0x7b, 0x22, 0xc3, 0x22, 0x3a, 0x30, 0x7d]))
    const encoding = spawnSync(process.execPath, [command, '--query', 'capture_summary', '--input', input, '--output', badOutput], { encoding: 'utf8', timeout: 5000 })
    assert.equal(encoding.status, 2); assert.equal(JSON.parse(encoding.stderr).code, 'input_encoding_invalid')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

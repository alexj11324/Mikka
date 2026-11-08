#!/usr/bin/env node
// Offline artifact preparation only. No network, MCP mutation, query, export or PNG rendering.
// A prepared request is not evidence that its source was a production run or that a PNG is readable.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { reconcile } from '../ops1512/reconcile-production-evidence.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const args = process.argv.slice(2), flags = {}
if (args.length === 1 && args[0] === '--help') {
  console.log('Offline only: node prepare-native-apm-saved-view.mjs --manifest ACTUAL_NORMALIZED_MANIFEST.json --case SAFE_CASE_LABEL --out NEW_LOCAL_DIRECTORY [--rows 1..8]')
  process.exit(0)
}
for (let i = 0; i < args.length; i += 2) {
  if (!['--manifest', '--case', '--out', '--rows'].includes(args[i]) || !args[i + 1] || Object.hasOwn(flags, args[i])) throw new Error('invalid_arguments')
  flags[args[i]] = args[i + 1]
}
if (!flags['--manifest'] || !flags['--out'] || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(flags['--case'] ?? '')) throw new Error('missing_or_invalid_arguments')
if (flags['--rows'] !== undefined && !/^[1-8]$/.test(flags['--rows'])) throw new Error('invalid_display_page_size')

const templateBytes = readFileSync(new URL('./native-apm-saved-view-template.safe.json', import.meta.url))
const template = JSON.parse(templateBytes)
const canonicalBytes = readFileSync(new URL('../ops1512/production-evidence-query-templates.json', import.meta.url))
const canonical = JSON.parse(canonicalBytes)
const canonicalTimeline = canonical.queries.span_timeline
if (typeof canonicalTimeline !== 'string' || sha(canonicalTimeline) !== template.canonicalSpanTimelineSqlSha256) throw new Error('canonical_timeline_binding_changed')
const manifestBytes = readFileSync(flags['--manifest'])
const manifest = JSON.parse(manifestBytes)
const reconciliation = reconcile(manifest)
if (reconciliation.status !== 'sets_consistent') throw new Error('existing_canonical_reconciliation_not_consistent')
const trace = /^[0-9a-f]{32}$/, uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const span = /^[0-9a-f]{16}$/, stage = /^[A-Za-z0-9][A-Za-z0-9 ._:/[\]{}()-]{0,255}$/
const denied = /https?:\/\/|(?:^|[\s/:])(?:ph[cx]_|sk[-_]|gh[pousr]_|github_pat_)|@|\.\.\.|…|\b(?:truncated|omitted)\b/i
const columns = ['service', 'stage', 'offset_ms', 'duration_ms', 'status_code', 'span_id_hex', 'parent_span_id_hex']
const window = manifest.window
const iso = value => value.replace(' ', 'T') + 'Z'
const planned = []
for (const [traceId, tables] of Object.entries(manifest.snapshots.after.traces)) {
  if (!trace.test(traceId) || /^0+$/.test(traceId)) throw new Error('invalid_trace')
  const timeline = tables.span_timeline
  // Preserve the frozen query's order. Do not re-sort decoded hex IDs (base64 order differs).
  const rows = timeline.pages.flatMap(page => page.rows)
  if (!rows.length) throw new Error('empty_timeline')
  for (const row of rows) {
    if (!uuid.test(row.span_row_uuid) || !['mikka-web', 'mikka-daemon'].includes(row.service) ||
        !stage.test(row.stage) || denied.test(row.stage) || !span.test(row.span_id_hex) || !span.test(row.parent_span_id_hex) ||
        !Number.isFinite(row.offset_ms) || row.offset_ms < 0 || !Number.isFinite(row.duration_ms) || row.duration_ms < 0 ||
        !Number.isInteger(row.status_code)) throw new Error('unsafe_or_invalid_display_metadata')
  }
  if (template.rowsPerDisplayPage !== 8) throw new Error('display_template_capacity_changed')
  const size = flags['--rows'] === undefined ? template.rowsPerDisplayPage : Number(flags['--rows'])
  const anchor = rows.map(row => row.started_utc).sort()[0]
  const pages = Math.ceil(rows.length / size)
  for (let offset = 0; offset < rows.length; offset += size) {
    const slice = rows.slice(offset, offset + size), page = offset / size + 1
    const params = {
      case_name: flags['--case'], trace_id_hex: traceId,
      window_start_utc: window[0], window_end_utc: window[1],
      window_start_iso: iso(window[0]), window_end_iso: iso(window[1]), anchor_utc: anchor,
      page_number: String(page), page_count: String(pages), row_start: String(offset + 1), row_end: String(offset + slice.length), row_count: String(rows.length),
      row_uuids_sql: slice.map(row => "'" + row.span_row_uuid + "'").join(', '),
      page_limit: String(slice.length + 1),
    }
    const replace = value => typeof value === 'string' ? value.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => {
      if (!Object.hasOwn(params, key)) throw new Error('unknown_template_parameter')
      return params[key]
    }) : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)])) : value
    const request = replace(template.insightCreate)
    if (JSON.stringify(request).includes('{{') || request.name.length > 400 || request.description.length > 400) throw new Error('unbound_or_oversize_request')
    const base = traceId + '-p' + String(page).padStart(3, '0')
    const rowUuids = slice.map(row => row.span_row_uuid)
    planned.push({ base, request, expected: {
      kind: 'display_projection_expected_from_canonical_metadata', actualProductionEvidence: false,
      projectId: 670821, traceId, window, page, pages, range: [offset + 1, offset + slice.length], totalRows: rows.length,
      rowUuids, rowUuidsSha256: sha(JSON.stringify(rowUuids)), columns,
      expectedRows: slice.map(row => Object.fromEntries(columns.map(key => [key, row[key]]))),
      querySha256: sha(request.query.source.query),
      note: 'Compare real insight-query results in this exact order before export; expected rows are not server results or a PNG.',
    } })
  }
}
if (!planned.length) throw new Error('no_pages')
// Prepare all payloads successfully before creating a new directory; never overwrite prior evidence.
mkdirSync(flags['--out'], { mode: 0o700 })
const write = (name, value) => writeFileSync(join(flags['--out'], name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
for (const page of planned) {
  write(page.base + '.insight-create.json', page.request)
  write(page.base + '.expected.json', page.expected)
}
const result = {
  schemaVersion: 1, kind: 'offline_native_apm_saved_view_preparation', status: 'prepared_not_queried_or_rendered',
  actualProductionEvidence: false, upstreamCompleteness: 'not_proven', projectId: 670821, caseLabel: flags['--case'], window,
  rowsPerDisplayPage: Number(flags['--rows'] ?? template.rowsPerDisplayPage),
  manifestSha256: sha(manifestBytes), templateSha256: sha(templateBytes), canonicalTemplatesSha256: sha(canonicalBytes),
  existingReconciliationStatus: reconciliation.status, dataQueries: 0, objectsCreated: 0, exportsStarted: 0,
  pages: planned.map(({ base, expected }) => ({ traceId: expected.traceId, page: expected.page, range: expected.range,
    requestFile: base + '.insight-create.json', expectedFile: base + '.expected.json', querySha256: expected.querySha256, rowUuidsSha256: expected.rowUuidsSha256 })),
}
write('plan.json', result)
console.log(JSON.stringify({ status: result.status, traces: new Set(planned.map(page => page.expected.traceId)).size, pages: planned.length, dataQueries: 0, objectsCreated: 0, exportsStarted: 0 }))

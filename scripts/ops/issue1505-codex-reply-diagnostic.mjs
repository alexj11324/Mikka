#!/usr/bin/env node
// REVIEW DRAFT ONLY: one bounded retained-record replay; no workflow or DB invocation has occurred.
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const SOURCE = '89eae89e9e79422e0a8b4b1346aa1c7fb6470016'
const RUN = 'bcd5de6f-244c-482a-9409-fd09bca4a6ef'
const TASK = 'ed029a48-f08d-4f27-912b-70dda9c7da93'
const OWNER_HASH = 'b823ba1c5729768b'
const DRIVER_BLOB = '1bca723b8110625b48127a1d28ade9ecf0e153de'
const DRIVER_SHA256 = 'e3ae3c84925100ac0c79a2b0d7dac70933312acd2e235fef5f2fe9d572da65b2'
const FILES = ['scripts/acceptance/cloud-startup.mjs', 'scripts/acceptance/cloud-startup-evidence.mjs',
  'scripts/acceptance/team-workspace.mjs', 'lib/smoke-account.ts']
const SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout = '5s';\nSET LOCAL lock_timeout = '1s';\nSET LOCAL idle_in_transaction_session_timeout = '10s';\nSET LOCAL search_path = pg_catalog, public;\nWITH\ntarget AS MATERIALIZED (\n SELECT r.id, r.\"issueId\", r.\"userId\", r.status, r.\"finishedAt\",\n        r.\"createdAt\", r.\"retryOf\", r.\"continuesRunId\", r.\"questionContinuation\",\n        r.\"botId\", r.\"agentDefinition\" AS definition,\n        r.prompt, r.report, r.error, i.content,\n        substring(i.title FROM '^测试 1505 ([0-9a-f]{8}_1) codex$') AS sample_id,\n        (i.content#>'{attrs,mikka,deletedAt}' IS NOT NULL AND i.content#>'{attrs,mikka,deletedAt}'<>'null'::jsonb) AS metadata_mikka_deleted_at_present,\n        (i.content#>'{attrs,orvilo,deletedAt}' IS NOT NULL AND i.content#>'{attrs,orvilo,deletedAt}'<>'null'::jsonb) AS metadata_legacy_deleted_at_present,\n        a.harness AS ui_harness\n FROM public.agent_runs r\n JOIN public.issues i ON i.id=r.\"issueId\"\n JOIN public.agents a ON a.id=r.\"agentId\"\n WHERE r.id='bcd5de6f-244c-482a-9409-fd09bca4a6ef'::uuid\n   AND r.\"issueId\"='ed029a48-f08d-4f27-912b-70dda9c7da93'::uuid\n   AND r.\"userId\"='cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3'\n   AND i.\"userId\"=r.\"userId\" AND a.\"userId\"=r.\"userId\"\n),\nmarked AS MATERIALIZED (\n SELECT t.*, 'STARTUP_OK_'||sample_id AS marker,\n        definition->'executionIdentity' AS identity,\n        definition->'agentProfile' AS profile\n FROM target t\n),\nscope_fields AS MATERIALIZED (\n SELECT m.*,\n   (sample_id IS NOT NULL) AS title_matches,\n   (ui_harness='codex' AND definition->>'harness'='codex' AND definition->>'model'='gpt-6-luna') IS TRUE AS model_matches,\n   ((definition->'apiKey' IS NULL OR definition->'apiKey'='null'::jsonb)\n     AND jsonb_typeof(definition->'subscription')='object'\n     AND definition#>>'{subscription,route}'='codex_cli') IS TRUE AS subscription_matches,\n   (\"createdAt\">='2026-11-09T07:51:40Z'::timestamptz\n     AND \"createdAt\"<='2026-11-09T07:54:20Z'::timestamptz) IS TRUE AS time_matches,\n   (identity->'version'='1'::jsonb\n     AND identity->>'requester'=\"userId\" AND identity->>'executionPrincipal'=\"userId\"\n     AND identity->>'outputOwner'=\"userId\" AND identity->>'botOwner'=\"userId\"\n     AND identity->>'botId'=\"botId\"::text\n     AND identity->>'personalResourcePolicy'='requester_only'\n     AND identity#>>'{billingAccount,model,kind}'='subscription'\n     AND identity->>'workspaceId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') IS TRUE AS identity_matches,\n   (profile->>'source'='explicit'\n     AND profile->>'profileId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'\n     AND profile->>'digest' ~ '^[0-9a-f]{64}$'\n     AND jsonb_typeof(profile->'version')='number'\n     AND profile->>'version' ~ '^[1-9][0-9]*$') IS TRUE AS profile_matches\n FROM marked m\n),\nbound AS MATERIALIZED (\n SELECT s.*,\n        (title_matches AND model_matches AND subscription_matches AND time_matches\n          AND identity_matches AND profile_matches) AS historical_scope_matches,\n        strpos(prompt,marker)>0 AS prompt_marker,\n        (jsonb_typeof(content#>'{content,0,content,0,text}')='string'\n          AND strpos(content#>>'{content,0,content,0,text}',marker)>0) IS TRUE AS issue_text_marker,\n        (jsonb_typeof(report)='object' AND jsonb_typeof(report->'summary')='string'\n          AND strpos(report->>'summary',marker)>0) IS TRUE AS report_marker,\n        (jsonb_typeof(report)='object' AND jsonb_typeof(report->'summary')='string'\n          AND (report->>'summary') ~ U&'[^\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]') IS TRUE AS report_nonblank,\n        (coalesce(error,'') ~ U&'[^\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]') AS error_nonblank\n FROM scope_fields s\n),\nchain_flags AS MATERIALIZED (\n SELECT b.*,\n EXISTS (\n   SELECT 1 FROM public.agent_runs p\n   WHERE p.\"userId\"=b.\"userId\" AND p.\"issueId\" IS NOT DISTINCT FROM b.\"issueId\"\n     AND p.id IN (b.\"retryOf\", b.\"continuesRunId\",\n       CASE WHEN b.\"questionContinuation\"->>'originRunId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'\n            THEN (b.\"questionContinuation\"->>'originRunId')::uuid END)\n ) AS has_parent_edge,\n EXISTS (\n   SELECT 1 FROM public.agent_runs c\n   WHERE c.\"userId\"=b.\"userId\" AND c.\"issueId\" IS NOT DISTINCT FROM b.\"issueId\"\n     AND b.id IN (c.\"retryOf\",c.\"continuesRunId\",\n       CASE WHEN c.\"questionContinuation\"->>'originRunId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'\n            THEN (c.\"questionContinuation\"->>'originRunId')::uuid END)\n ) AS has_child_edge\n FROM bound b\n),\nlimited AS MATERIALIZED (\n SELECT c.seq,c.\"createdAt\",c.chunk\n FROM public.run_chunks c JOIN bound b ON b.id=c.\"runId\"\n WHERE b.historical_scope_matches\n ORDER BY c.seq\n LIMIT 2049\n),\nstats AS MATERIALIZED (\n SELECT count(*) AS n, min(seq) AS first_seq, max(seq) AS last_seq,\n coalesce(sum(pg_column_size(chunk)),0) AS stored_bytes,\n count(*) FILTER (WHERE chunk->>'type'='data-run-stage' AND jsonb_typeof(chunk#>'{data,ms}')='number' AND length(chunk#>>'{data,ms}')>64) AS unsupported_stage_numbers,\n coalesce(sum(CASE WHEN chunk->>'type'='text-delta' AND jsonb_typeof(chunk->'delta')='string'\n                   THEN octet_length(chunk->>'delta') ELSE 0 END),0) AS text_bytes\n FROM limited\n),\nsafe_rows AS MATERIALIZED (\n SELECT l.* FROM limited l CROSS JOIN stats s\n WHERE s.n<=2048 AND s.stored_bytes<=4194304 AND s.text_bytes<=1048576\n),\nprojected AS MATERIALIZED (\n SELECT l.seq,l.\"createdAt\",\n jsonb_build_object(\n   'type',CASE WHEN l.chunk->>'type' IN ('data-run-stage','text-delta','reasoning-delta','tool-input-start','tool-input-available','tool-output-available','tool-output-error','finish')\n               THEN l.chunk->>'type' ELSE 'other' END,\n   'data',CASE WHEN l.chunk->>'type'='data-run-stage' THEN jsonb_build_object(\n     'stage',CASE WHEN l.chunk#>>'{data,stage}' IN ('repository','worktree','agent_start') THEN l.chunk#>>'{data,stage}' END,\n     'ms',CASE WHEN jsonb_typeof(l.chunk#>'{data,ms}')='number' AND length(l.chunk#>>'{data,ms}')<=64 THEN l.chunk#>'{data,ms}' END,\n     'ok',CASE WHEN jsonb_typeof(l.chunk#>'{data,ok}')='boolean' THEN l.chunk#>'{data,ok}' END\n   ) END,\n   'toolCallId',CASE WHEN jsonb_typeof(l.chunk->'toolCallId')='string' AND length(l.chunk->>'toolCallId')<=512 THEN l.chunk->'toolCallId' END,\n   'toolName',CASE WHEN l.chunk->>'toolName'='mcp__mikka__submit' THEN 'mcp__mikka__submit' ELSE 'other' END,\n   'inputIsObject',(jsonb_typeof(l.chunk->'input')='object') IS TRUE,\n   'inputSummaryIsString',(jsonb_typeof(l.chunk#>'{input,summary}')='string') IS TRUE,\n   'input',jsonb_build_object('summary',CASE\n      WHEN jsonb_typeof(l.chunk#>'{input,summary}')='string' AND strpos(l.chunk#>>'{input,summary}',b.marker)>0 THEN b.marker ELSE '' END),\n   'delta',CASE WHEN l.chunk->>'type'='text-delta' AND jsonb_typeof(l.chunk->'delta')='string' THEN l.chunk->'delta'\n                WHEN l.chunk->>'type'='reasoning-delta' AND jsonb_typeof(l.chunk->'delta')='string' AND length(l.chunk->>'delta')>0 THEN to_jsonb('x'::text) END\n ) AS chunk\n FROM safe_rows l CROSS JOIN bound b\n)\nSELECT jsonb_build_object(\n 'schemaVersion',1,'readOnly',current_setting('transaction_read_only')='on',\n 'snapshotAt',transaction_timestamp(),'encoding',current_setting('server_encoding'),\n 'targetFound',EXISTS(SELECT 1 FROM bound),\n 'binding', (SELECT jsonb_build_object(\n    'scopeMatches',historical_scope_matches,'sampleId',sample_id,\n    'scopeChecks',jsonb_build_object('title',title_matches,'model',model_matches,'subscription',subscription_matches,'time',time_matches,'identity',identity_matches,'profile',profile_matches),\n    'metadataMikkaDeletedAtPresent',metadata_mikka_deleted_at_present,\n    'metadataLegacyDeletedAtPresent',metadata_legacy_deleted_at_present,\n    'promptMarker',coalesce(prompt_marker,false),'issueTextMarker',issue_text_marker,\n    'harnessMatches',ui_harness='codex',\n    'profileIdHash',left(encode(sha256(convert_to(coalesce(profile->>'profileId',''),'UTF8')),'hex'),16),\n    'profileDigest',CASE WHEN profile->>'digest' ~ '^[0-9a-f]{64}$' THEN profile->>'digest' END,\n    'requesterHash',left(encode(sha256(convert_to(\"userId\",'UTF8')),'hex'),16),\n    'hasParentEdge',has_parent_edge,'hasChildEdge',has_child_edge,\n    'status',CASE WHEN status IN ('queued','preparing','running','paused','waiting_input','finishing','succeeded','stopped','failed','cancelled') THEN status ELSE 'unknown' END,\n    'finishedAt',CASE WHEN isfinite(\"finishedAt\") THEN \"finishedAt\" END,\n    'reportMarker',report_marker,\n    'summarySource',CASE WHEN report_nonblank THEN 'report' WHEN error_nonblank THEN 'error' END\n ) FROM chain_flags),\n 'coverage',(SELECT jsonb_build_object(\n    'countCapped',n,'rowCap',2048,'limitExceeded',n>2048,\n    'storedBytes',stored_bytes,'textBytes',text_bytes,\n    'byteLimitExceeded',stored_bytes>4194304 OR text_bytes>1048576,\n    'unsupportedStageNumbers',unsupported_stage_numbers,\n    'firstSeq',first_seq,'lastSeq',last_seq,\n    'contiguousObserved',CASE WHEN n>0 THEN last_seq-first_seq+1=n ELSE null END\n ) FROM stats),\n 'chunks',coalesce((SELECT jsonb_agg(jsonb_build_object('seq',seq,'at',\"createdAt\",'chunk',chunk) ORDER BY seq) FROM projected),'[]'::jsonb)\n)::text;\nROLLBACK;\n"
const sha = value => createHash('sha256').update(value).digest('hex')
const dateValue = value => typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN
const fail = code => { const e = new Error(code); e.closedCode = code; throw e }
const check = (ok, code) => { if (!ok) fail(code) }
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at < 0 ? fallback : process.argv[at + 1]
}
const sourceDir = arg('--source-dir', process.env.SOURCE_DIR)
const output = arg('--output', process.env.OUTPUT)
const verifyOnly = process.argv.includes('--verify-only')
const allowedArgs = new Set(['--source-dir', '--output', '--verify-only'])
for (let i = 2; i < process.argv.length; i++) {
  check(allowedArgs.has(process.argv[i]), 'argument_not_allowed')
  if (process.argv[i] !== '--verify-only') { check(typeof process.argv[++i] === 'string', 'argument_value_missing') }
}
check(typeof sourceDir === 'string' && isAbsolute(sourceDir), 'source_directory_invalid')
check(typeof output === 'string' && isAbsolute(output) && output.endsWith('.json'), 'output_path_invalid')
const identity = { source: SOURCE, runId: RUN, taskId: TASK, requesterHash: OWNER_HASH,
  candidateBinding: 'awaiting_original_candidate_identity_receipt' }
let closed = { schemaVersion: 1, kind: 'retained_record_marker_replay', identity,
  result: 'not_run', formalVerdict: 'not_evaluated', newModels: 0, businessWrites: 0 }
let privateProjection

function command(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576, ...options })
}
function git(...args) {
  const r = command('git', ['-C', sourceDir, ...args])
  check(r.status === 0 && !r.error && !r.signal, 'source_git_verification_failed')
  return r.stdout.trim()
}
async function verifySource() {
  check(Number(process.versions.node.split('.')[0]) >= 24, 'node_24_required')
  check(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'node_injection_environment_not_allowed')
  check(git('rev-parse', 'HEAD') === SOURCE, 'historical_source_mismatch')
  check(git('status', '--porcelain', '--untracked-files=no') === '', 'historical_checkout_modified')
  check(git('rev-parse', 'HEAD:scripts/acceptance/cloud-startup.mjs') === DRIVER_BLOB, 'driver_blob_mismatch')
  const files = []
  for (const path of FILES) {
    const bytes = await readFile(resolve(sourceDir, path))
    const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
    check(git('rev-parse', 'HEAD:' + path) === blob, 'source_dependency_modified')
    if (path === FILES[0]) check(sha(bytes) === DRIVER_SHA256, 'driver_sha256_mismatch')
    files.push({ path, bytes: bytes.length, blob, sha256: sha(bytes) })
  }
  const psql = command('psql', ['--version'])
  check(psql.status === 0 && /^psql \(PostgreSQL\) [0-9]+\./.test(psql.stdout), 'psql_not_available')
  return { files, psqlVersion: psql.stdout.trim().slice(0,80) }
}
function connectionEnvironment(secret) {
  let url
  try { url = new URL(secret) } catch { fail('application_database_url_invalid') }
  check(['postgres:', 'postgresql:'].includes(url.protocol) && !!url.hostname
    && !!url.username && !!url.password && url.pathname.length > 1 && !url.hash, 'application_database_url_invalid')
  const allowed = new Set(['sslmode', 'channel_binding'])
  for (const key of url.searchParams.keys()) check(allowed.has(key), 'database_parameter_not_reviewed')
  const sslmode = url.searchParams.get('sslmode')
  check(['require','verify-ca','verify-full'].includes(sslmode), 'database_tls_mode_not_reviewed')
  const channelBinding = url.searchParams.get('channel_binding')
  check(channelBinding === null || ['prefer','require'].includes(channelBinding), 'channel_binding_not_reviewed')
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC',
    PGPASSFILE: '/dev/null',
    PGHOST: url.hostname, PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: sslmode, ...(channelBinding ? { PGCHANNELBINDING: channelBinding } : {}),
    PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'issue1505-runtime89-readonly',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000'
  }
}
function sequencePredicates(rows, marker) {
  let started = false, completed = false, submittedAt = null, lastSubmitSeq = null
  let reply = '', post = '', textMarker = false, afterToolMarker = false
  const inputs = new Set(), submits = new Set(), first = {}, counts = {
    stageStarts: 0, canonicalSubmitInputs: 0, submitInputsWithMarker: 0,
    eligibleSubmitInputs: 0, matchingSubmitOutputs: 0, textChunks: 0 }
  const submitEvents = []
  for (const item of rows) {
    const c = item.chunk, at = dateValue(item.at)
    if (c.type === 'data-run-stage') {
      const d = c.data
      if (['repository','worktree','agent_start'].includes(d?.stage) && Number.isFinite(d.ms)
          && typeof d.ok === 'boolean' && d.stage === 'agent_start' && d.ok) {
        started = true; counts.stageStarts++; first.agentStartSeq ??= item.seq
      }
    } else if (started) {
      if (['tool-input-start','tool-input-available','tool-output-available','tool-output-error'].includes(c.type)
          && typeof c.toolCallId === 'string' && c.toolCallId.length > 0 && c.toolCallId.length <= 512) {
        const hash = sha(c.toolCallId).slice(0,16)
        if (c.type === 'tool-input-available' && c.toolName === 'mcp__mikka__submit') {
          const markerSeen = typeof c.input?.summary === 'string' && c.input.summary.includes(marker)
          counts.canonicalSubmitInputs++; if (markerSeen) counts.submitInputsWithMarker++
          if (submitEvents.length < 16) submitEvents.push({ seq: item.seq, toolCallHash: hash,
            inputIsObject: c.inputIsObject === true, inputSummaryIsString: c.inputSummaryIsString === true,
            marker: markerSeen, priorCompletedTool: completed })
          if (markerSeen && completed) { submits.add(hash); counts.eligibleSubmitInputs++ }
        }
        if (c.type === 'tool-output-available' && submits.has(hash) && Number.isFinite(at)) {
          submittedAt = at; lastSubmitSeq = item.seq; counts.matchingSubmitOutputs++
        }
        if (c.type.startsWith('tool-input-') && inputs.size < 64) inputs.add(hash)
        if (c.type === 'tool-output-available' && inputs.has(hash)) {
          completed = true; first.completedToolSeq ??= item.seq
        }
      }
      if (c.type === 'text-delta' && typeof c.delta === 'string') {
        counts.textChunks++; first.textSeq ??= item.seq
        reply += c.delta
        if (reply.includes(marker)) { textMarker = true; first.textMarkerSeq ??= item.seq }
        reply = reply.slice(-256)
        if (completed) {
          post += c.delta
          if (post.includes(marker)) { afterToolMarker = true; first.afterToolMarkerSeq ??= item.seq }
          post = post.slice(-256)
        }
      }
    }
  }
  return { counts, first, submitEvents, submitEventsTruncated: counts.canonicalSubmitInputs > submitEvents.length,
    textMarker, afterToolMarker, submittedAt, lastSubmitSeq, completedToolSeen: completed }
}
try {
  const source = await verifySource()
  closed.sourceVerification = source
  if (verifyOnly) {
    closed.result = 'source_verified_only'
  } else {
    const secret = process.env.MIKKA_DATABASE_URL
    check(typeof secret === 'string' && secret.length > 0, 'application_database_url_missing')
    delete process.env.MIKKA_DATABASE_URL
    const childEnv = connectionEnvironment(secret)
    const result = spawnSync('psql', ['--no-psqlrc','--no-password','--quiet','--tuples-only','--no-align',
      '--set=ON_ERROR_STOP=1','--set=VERBOSITY=sqlstate'], {
      input: SQL, env: childEnv, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 8388608,
    })
    childEnv.PGPASSWORD = ''
    const sqlState = /(?:ERROR|FATAL):\s+([0-9A-Z]{5})(?:\s|$)/.exec(result.stderr ?? '')?.[1]
    const queryStates = new Set(['08000','08001','08003','08004','08006','08007','08P01','22001','22003','22007','22023',
      '25006','25P02','28000','28P01','3D000','3F000','42501','42601','42703','42804','42883','42P01','55P03','57014','57P01','53300','53400','XX000'])
    const connectionErrorKinds = [
      ['unsupported_startup_parameter', /unsupported startup parameter|unsupported startup option|unsupported.*parameter.*options/i],
      ['password_authentication_failed', /password authentication failed|SASL authentication failed|SCRAM authentication failed|no password supplied/i],
      ['role_missing', /role .* does not exist/i],
      ['database_missing', /database .* does not exist/i],
      ['dns_resolution_failed', /could not translate host name|Name or service not known|Temporary failure in name resolution/i],
      ['connection_refused', /connection refused/i],
      ['connection_timeout', /timeout expired|connection timed out/i],
      ['tls_or_channel_binding', /SSL|TLS|certificate|channel binding/i],
      ['connection_closed', /server closed the connection|connection.*closed unexpectedly/i],
      ['endpoint_not_identified', /endpoint ID is not specified|endpoint.*not found/i],
    ].filter(([, pattern]) => pattern.test(result.stderr ?? '')).map(([kind]) => kind)
    const startupParameterNames = ['default_transaction_read_only','statement_timeout','lock_timeout','idle_in_transaction_session_timeout']
      .filter(name => (result.stderr ?? '').includes(name))
    closed.queryProcess = { connectionErrorKinds, startupParameterNames, exitCode: Number.isInteger(result.status) ? result.status : null,
      signal: ['SIGKILL','SIGTERM'].includes(result.signal) ? result.signal : null,
      timedOut: result.error?.code === 'ETIMEDOUT',
      postgresSqlState: sqlState === undefined ? null : queryStates.has(sqlState) ? sqlState : 'unmapped' }
    check(!result.error && !result.signal && result.status === 0, 'readonly_query_failed')
    try { privateProjection = JSON.parse(result.stdout.trim()) } catch { fail('readonly_projection_invalid') }
    result.stdout = ''; result.stderr = ''
    check(privateProjection?.schemaVersion === 1 && privateProjection.readOnly === true, 'readonly_transaction_unconfirmed')
    check(privateProjection.encoding === 'UTF8', 'database_encoding_unsupported')
    closed.snapshotAt = privateProjection.snapshotAt
    closed.coverage = privateProjection.coverage
    closed.targetFound = privateProjection.targetFound === true
    closed.scopeMatches = privateProjection.binding?.scopeMatches === true
    closed.scopeChecks = Object.fromEntries(['title','model','subscription','time','identity','profile'].map(key =>
      [key, typeof privateProjection.binding?.scopeChecks?.[key] === 'boolean' ? privateProjection.binding.scopeChecks[key] : null]))
    check(privateProjection.targetFound === true && privateProjection.binding?.scopeMatches === true, 'target_ownership_or_provenance_mismatch')
    const b = privateProjection.binding
    check(b.requesterHash === OWNER_HASH && /^[0-9a-f]{8}_1$/.test(b.sampleId), 'fixed_acceptance_identity_mismatch')
    check(!closed.coverage.limitExceeded && !closed.coverage.byteLimitExceeded
      && closed.coverage.unsupportedStageNumbers === 0, 'bounded_projection_incomplete')
    check(Array.isArray(privateProjection.chunks) && privateProjection.chunks.length === closed.coverage.countCapped, 'chunk_count_mismatch')
    const rows = privateProjection.chunks, isolated = !b.hasParentEdge && !b.hasChildEdge
    const marker = 'STARTUP_OK_' + b.sampleId
    const seq = sequencePredicates(rows, marker)
    globalThis.fetch = async () => { fail('network_from_replay_forbidden') }
    const { observeChunks } = await import(pathToFileURL(resolve(sourceDir, FILES[0])).href)
    const record = { sampleId: b.sampleId, runId: RUN, harness: 'codex', stages: [], toolCalls: [],
      requireReply: true, minToolCalls: 1, requireRuntimeReceipt: true, requireTerminal: true,
      requireReplyAfterTool: true, requireOfficialTiming: true }
    const detail = { chunks: rows, thread: {
      id: RUN, rootRunId: isolated ? RUN : null, latestRunId: isolated ? RUN : null,
      ownedByCurrentUser: true, status: b.status, finishedAt: b.finishedAt,
      error: isolated && b.status === 'succeeded' ? null : undefined,
      continuation: isolated ? null : { id: null, status: 'unknown' },
      attempts: isolated ? [{ runId: RUN, status: b.status }] : [],
      detail: { harness: 'codex', summarySource: b.summarySource, summary: b.reportMarker ? marker : '' },
    } }
    // Return value is intentionally discarded: timing/native receipt fields were not fetched.
    observeChunks(record, detail, Date.now())
    const finished = dateValue(b.finishedAt)
    const markerBindingVerified = b.promptMarker === true && b.issueTextMarker === true
    closed.binding = { scopeMatches: b.scopeMatches,
      metadataMikkaDeletedAtPresent: b.metadataMikkaDeletedAtPresent,
      metadataLegacyDeletedAtPresent: b.metadataLegacyDeletedAtPresent,
      markerBindingVerified,
      requesterHash: b.requesterHash, profileIdHash: b.profileIdHash, profileDigest: b.profileDigest,
      promptMarker: b.promptMarker, issueTextMarker: b.issueTextMarker, harnessMatches: b.harnessMatches,
      isolatedRun: isolated, parentEdge: b.hasParentEdge, childEdge: b.hasChildEdge,
      status: b.status, summarySource: b.summarySource }
    closed.replyProof = {
      postStartTextMarker: seq.textMarker, postToolTextMarker: seq.afterToolMarker,
      markerBindingVerified,
      reportSummaryMarker: b.reportMarker,
      submittedOutputMatched: seq.submittedAt !== null,
      finishedAtFinite: Number.isFinite(finished),
      finishedAtAtOrAfterSubmit: seq.submittedAt !== null && Number.isFinite(finished) && finished >= seq.submittedAt,
      singleSucceededUiErrorIsNull: isolated && b.status === 'succeeded',
      replayReplyVerified: record.replyVerified === true,
      replayReplyVerifiedAfterTool: record.replyVerifiedAfterTool === true,
      replySource: record.replySource === 'submitted_report' ? 'submitted_report' : null,
      firstProviderChunkObserved: !!record.firstProviderChunk, agentStartObserved: !!record.agentStart,
      successfulToolCountAtReplayEnd: record.toolCalls.filter(t=>t.outcome==='ok').length,
      counts: seq.counts, seq: seq.first, submitEvents: seq.submitEvents,
      submitEventsTruncated: seq.submitEventsTruncated,
      lastMatchedSubmitSeq: seq.lastSubmitSeq,
      lastMatchedSubmitStoredAt: seq.submittedAt === null ? null : new Date(seq.submittedAt).toISOString(),
      finishedAt: Number.isFinite(finished) ? new Date(finished).toISOString() : null,
    }
    closed.result = !markerBindingVerified ? 'retained_record_replay_marker_unknown'
      : isolated ? 'retained_record_replay_completed' : 'retained_record_replay_chain_unknown'
    closed.limitations = ['not_the_original_http_detail_snapshot','candidate_identity_not_finally_bound',
      'no_full_runtime_or_native_acceptance_verdict','no_new_formal_samples','no_cross_host_latency_subtraction',
      'metadata_deleted_at_presence_is_not_full_cleanup_verification',
      ...(!markerBindingVerified ? ['current_title_marker_not_bound_to_stored_prompt_and_issue_text'] : [])]
    rows.length = 0
  }
} catch (error) {
  closed.result = 'diagnostic_failed'
  closed.code = typeof error?.closedCode === 'string' && /^[a-z_]{1,80}$/.test(error.closedCode)
    ? error.closedCode : 'collector_failed'
  process.exitCode = 1
} finally {
  privateProjection = undefined
  delete process.env.MIKKA_DATABASE_URL
  const body = JSON.stringify(closed, null, 2) + '\n'
  check(Buffer.byteLength(body) <= 65536, 'closed_report_too_large')
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, body, { mode: 0o600 })
  console.log(JSON.stringify({ result: closed.result, code: closed.code ?? null,
    bytes: Buffer.byteLength(body), sha256: sha(body) }))
}

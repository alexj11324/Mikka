// Read-only, exact-case evidence. The caller supplies its existing owner client
// and a readonly query adapter; this module opens no connections or credentials.
// Only projected receipts leave memory. A receipt is not a transcript archive or
// proof that an image, a VM-local transcript, or an unenumerated object is clean.
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{64}$/
const TERMINAL = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])
const STATES = new Set(['prepared', 'requested', 'acknowledged', 'outcome_unknown'])
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (condition, code) => { if (!condition) throw Error(`task_secrets_evidence_${code}`) }
const integer = value => Number.isSafeInteger(value) && value >= 0
const utf8 = value => new TextDecoder('utf-8', { fatal: true }).decode(value)
const textBytes = value => Buffer.from(value, 'utf8')
const CATEGORIES = ['chunks', 'messages', 'checkpoint', 'artifact_versions', 'captures', 'capture_steps', 'run_definition']

export const TASK_SECRET_EVIDENCE_LIMITS = Object.freeze({ pageSize: 64, pagesPerCategory: 128,
  objects: 12_000, objectBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024,
  inflatedBytes: 64 * 1024 * 1024, streams: 4096, jsonDepth: 64 })

// The supplied Run id is never sufficient. Every data query repeats all five
// bindings, including the current Task and exact Bot relation. No account-wide
// export, fallback workspace, storage credentials, or another Run is consulted.
const SCOPE = `WITH scoped_run AS (
  SELECT r.id,r."userId",r."workspaceId",r."issueId",r."botId",r.status,r."updatedAt"
  FROM agent_runs r JOIN issues i ON i.id=r."issueId" AND i."userId"=r."userId"
    AND i."workspaceId"=r."workspaceId" AND i."ownershipState"='bound'
  JOIN bots b ON b.id=r."botId" AND b."ownerId"=r."userId" AND b."workspaceId"=r."workspaceId"
  WHERE r."userId"=$1 AND r."workspaceId"=$2::uuid AND r."botId"=$3::uuid
    AND r."issueId"=$4::uuid AND r.id=$5::uuid
)`

const ARTIFACT_JOIN = `FROM scoped_run s
  JOIN coordinator_events e ON e."runId"=s.id AND e."userId"=s."userId"
    AND e."issueId"=s."issueId" AND (e."botId" IS NULL OR e."botId"=s."botId") AND e.kind='artifact_submitted'
  JOIN artifacts a ON a.id::text=e.payload->>'artifactId' AND a."userId"=s."userId"
    AND a."workspaceId"=s."workspaceId"
  JOIN artifact_versions v ON v."artifactId"=a.id AND v.version::text=e.payload->>'version'
  WHERE jsonb_typeof(e.payload->'version')='number'
    AND e."dedupeKey"='artifact_submitted:' || a.id::text || ':' || v.version::text`

const SCOPE_QUERY = `/* task-secret-evidence:scope */ ${SCOPE}
  SELECT s.id,s."userId",s."workspaceId",s."botId",s."issueId",s.status,s."updatedAt"::text,
    current_setting('transaction_read_only') AS "readOnly",
    (SELECT count(*)::int FROM run_messages m WHERE m."runId"=s.id AND m."userId"<>s."userId") AS "messageGaps",
    (SELECT count(*)::int FROM run_checkpoints c WHERE c."runId"=s.id AND c."userId"<>s."userId") AS "checkpointGaps",
    (SELECT count(*)::int FROM run_captures c WHERE c."runId"=s.id AND
      (c."userId"<>s."userId" OR c."issueId" IS DISTINCT FROM s."issueId" OR c."botId" IS DISTINCT FROM s."botId")) AS "captureGaps",
    (SELECT count(*)::int FROM run_capture_steps p JOIN run_captures c ON c.id=p."captureId"
      WHERE c."runId"=s.id AND c."userId"=s."userId" AND c."issueId"=s."issueId" AND c."botId"=s."botId"
        AND p."userId"<>s."userId") AS "captureStepGaps",
    (SELECT count(*)::int FROM coordinator_events e WHERE e."runId"=s.id AND e."userId"=s."userId"
      AND e.kind='artifact_submitted' AND NOT EXISTS (
        SELECT 1 FROM artifacts a JOIN artifact_versions v ON v."artifactId"=a.id
        WHERE a."userId"=s."userId" AND a."workspaceId"=s."workspaceId" AND e."issueId"=s."issueId"
          AND (e."botId" IS NULL OR e."botId"=s."botId")
          AND a.id::text=e.payload->>'artifactId' AND v.version::text=e.payload->>'version'
          AND jsonb_typeof(e.payload->'version')='number'
          AND e."dedupeKey"='artifact_submitted:' || a.id::text || ':' || v.version::text)) AS "receiptGaps",
    (SELECT count(*)::int FROM artifacts a JOIN artifact_versions v ON v."artifactId"=a.id
      WHERE a."runId"=s.id AND a."userId"=s."userId" AND a."workspaceId"=s."workspaceId"
        AND NOT EXISTS (SELECT 1 FROM coordinator_events e WHERE e."runId"=s.id AND e."userId"=s."userId"
          AND e."issueId"=s."issueId" AND e.kind='artifact_submitted'
          AND (e."botId" IS NULL OR e."botId"=s."botId")
          AND e.payload->>'artifactId'=a.id::text AND e.payload->>'version'=v.version::text
          AND jsonb_typeof(e.payload->'version')='number'
          AND e."dedupeKey"='artifact_submitted:' || a.id::text || ':' || v.version::text)) AS "artifactGaps"
  FROM scoped_run s`

const SOURCES = {
  chunks: { cursor: 'bigint', sql: `SELECT c.id,c.seq::bigint AS position,
    jsonb_build_object('seq',c.seq) AS attributes,convert_to(c.chunk::text,'UTF8') AS payload
    FROM scoped_run s JOIN run_chunks c ON c."runId"=s.id` },
  messages: { cursor: 'bigint', sql: `SELECT m.id,m.sequence AS position,
    jsonb_build_object('sequence',m.sequence::text) AS attributes,
    convert_to(jsonb_build_object('text',m.text,'origin',m.origin,'failure',m.failure)::text,'UTF8') AS payload
    FROM scoped_run s JOIN run_messages m ON m."runId"=s.id AND m."userId"=s."userId"` },
  checkpoint: { cursor: 'uuid', sql: `SELECT c."runId" AS id,c."runId" AS position,
    jsonb_build_object('files',c.files,'unavailable',c."unavailableReason" IS NOT NULL,'patchPresent',c.patch IS NOT NULL,
      'takenAt',c."takenAt",'updatedAt',c."updatedAt") AS attributes,c.patch AS payload
    FROM scoped_run s JOIN run_checkpoints c ON c."runId"=s.id AND c."userId"=s."userId"` },
  artifact_versions: { cursor: 'uuid', sql: `SELECT DISTINCT v.id,v.id AS position,
    jsonb_build_object('artifactId',a.id,'version',v.version,'kind',a.kind,'contentBytes',v.size,
      'contentSha256',v.sha256,'createdAt',v."createdAt") AS attributes,
    convert_to(jsonb_build_object('submission',e.payload,'authorName',v."authorName",
      'executionIdentity',v."executionIdentity")::text,'UTF8') AS payload ${ARTIFACT_JOIN}` },
  captures: { cursor: 'uuid', sql: `SELECT c.id,c.id AS position,
    jsonb_build_object('kind',c.kind,'contentType',c."contentType",'status',c.status,'contentBytes',c.size,
      'contentSha256',c.sha256,'updatedAt',c."updatedAt") AS attributes,
    convert_to(jsonb_build_object('title',c.title,'error',c.error,'source',c.source)::text,'UTF8') AS payload
    FROM scoped_run s JOIN run_captures c ON c."runId"=s.id AND c."userId"=s."userId"
      AND c."issueId"=s."issueId" AND c."botId"=s."botId"` },
  capture_steps: { cursor: 'uuid', sql: `SELECT p.id,p.id AS position,
    jsonb_build_object('captureId',p."captureId",'atMs',p."atMs") AS attributes,
    convert_to(jsonb_build_object('label',p.label,'source',p.source)::text,'UTF8') AS payload
    FROM scoped_run s JOIN run_captures c ON c."runId"=s.id AND c."userId"=s."userId"
      AND c."issueId"=s."issueId" AND c."botId"=s."botId"
    JOIN run_capture_steps p ON p."captureId"=c.id AND p."userId"=s."userId"` },
  run_definition: { cursor: 'uuid', sql: `SELECT r.id,r.id AS position,'{}'::jsonb AS attributes,
    convert_to(jsonb_build_object('prompt',r.prompt,'agentDefinition',r."agentDefinition")::text,'UTF8') AS payload
    FROM scoped_run s JOIN agent_runs r ON r.id=s.id AND r."userId"=s."userId"
      AND r."workspaceId"=s."workspaceId" AND r."issueId"=s."issueId" AND r."botId"=s."botId"` },
}

function pageQuery(category) {
  const { sql, cursor } = SOURCES[category]
  return `/* task-secret-evidence:${category} */ ${SCOPE}, evidence AS (${sql}), page AS (
    SELECT * FROM evidence WHERE ($6::${cursor} IS NULL OR position>$6::${cursor})
    ORDER BY position LIMIT $7::integer)
    SELECT id::text,position::text AS cursor,attributes,octet_length(payload) AS "rawBytes",
      encode(sha256(payload),'hex') AS "rawSha256",
      CASE WHEN $8::boolean AND octet_length(payload)<=$9::integer
        AND sum(octet_length(payload)) OVER (ORDER BY position)<=$10::bigint THEN payload ELSE NULL END AS body
    FROM page ORDER BY position`
}

function inputs({ scope, canaries, limits }) {
  check(scope && typeof scope.ownerId === 'string' && scope.ownerId.length > 0 && scope.ownerId.length <= 256
    && ['workspaceId', 'botId', 'issueId', 'runId'].every(key => UUID.test(scope[key] ?? '')), 'scope')
  const descriptor = canaries?.descriptor
  check(descriptor?.format === 'synthetic_task_secret_v1' && descriptor.byteLength === 75
    && Array.isArray(descriptor.encodings) && descriptor.encodings.length === 1 && descriptor.encodings[0] === 'utf8', 'canaries')
  check(Array.isArray(canaries.generations) && canaries.generations.length > 0 && canaries.generations.length <= 3, 'canaries')
  const generations = canaries.generations.map(item => {
    check(integer(item.generation) && item.generation > 0 && SHA.test(item.sha256 ?? '') && STATES.has(item.state), 'canaries')
    return { generation: item.generation, sha256: item.sha256, state: item.state }
  })
  check(new Set(generations.map(item => item.generation)).size === generations.length, 'canaries')
  const cap = { ...TASK_SECRET_EVIDENCE_LIMITS }
  for (const [key, value] of Object.entries(limits ?? {})) {
    check(Object.hasOwn(cap, key) && integer(value) && value > 0 && value <= cap[key], 'limits')
    cap[key] = value
  }
  return { cap, generations, values: [scope.ownerId, scope.workspaceId, scope.botId, scope.issueId, scope.runId] }
}

function scanner(generations, cap) {
  const targets = new Map()
  for (const item of generations) targets.set(item.sha256, [...(targets.get(item.sha256) ?? []), item.generation])
  const streams = new Map()
  const reasons = new Set()
  const match = (text, hits) => {
    for (const found of text.matchAll(/mikka1712s_[a-f0-9]{64}/g)) {
      for (const generation of targets.get(hash(found[0])) ?? []) hits.add(generation)
    }
  }
  function deep(value, hits, local, depth = 0) {
    if (depth > cap.jsonDepth) { local.add('json_depth_limit'); return }
    if (typeof value === 'string') {
      if (!value.isWellFormed()) local.add('malformed_utf8')
      match(value, hits)
      // Tool inputs can themselves be JSON strings. Decode only syntactically
      // complete JSON, not guessed base64/URLs or arbitrary executable formats.
      if (['[', '{', '"'].includes(value.trimStart()[0])) {
        let parsed
        try { parsed = JSON.parse(value) } catch { return }
        if (parsed !== value) deep(parsed, hits, local, depth + 1)
      }
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) { match(key, hits); deep(item, hits, local, depth + 1) }
    }
  }
  const kinds = {
    'text-start': ['text', 'start', 'id'], 'text-delta': ['text', 'delta', 'id', 'delta'], 'text-end': ['text', 'end', 'id'],
    'reasoning-start': ['reasoning', 'start', 'id'], 'reasoning-delta': ['reasoning', 'delta', 'id', 'delta'], 'reasoning-end': ['reasoning', 'end', 'id'],
    'tool-input-start': ['tool', 'start', 'toolCallId'], 'tool-input-delta': ['tool', 'delta', 'toolCallId', 'inputTextDelta'],
    'tool-input-available': ['tool', 'end', 'toolCallId'], 'tool-input-error': ['tool', 'end', 'toolCallId'],
  }
  function chunk(value, hits, local) {
    deep(value, hits, local)
    if (!value || Array.isArray(value) || typeof value.type !== 'string') { local.add('malformed_stream'); return }
    const kind = kinds[value.type]
    if (!kind) {
      if (value.type.endsWith('-delta') || Object.hasOwn(value, 'delta') || Object.hasOwn(value, 'inputTextDelta')) local.add('unsupported_stream')
      return
    }
    const [prefix, action, idField, textField] = kind, id = value[idField]
    if (typeof id !== 'string' || !id || id.length > 1024 || !id.isWellFormed()) { local.add('malformed_stream'); return }
    const key = `${prefix}:${id}`
    if (action === 'start') {
      if (streams.has(key)) { local.add('malformed_stream'); return }
      if (streams.size >= cap.streams) { local.add('stream_limit'); return }
      streams.set(key, { decoder: new TextDecoder('utf-8', { fatal: true }), tail: '' })
      return
    }
    const stream = streams.get(key)
    // A complete tool-input-available may arrive without a streamed prefix.
    if (!stream) { if (action === 'delta' || prefix !== 'tool') local.add('malformed_stream'); return }
    if (action === 'end') {
      try { match(stream.tail + stream.decoder.decode(), hits) } catch { local.add('malformed_utf8') }
      streams.delete(key)
      return
    }
    const delta = value[textField]
    if (typeof delta !== 'string' || !delta.isWellFormed()) { local.add('malformed_stream'); return }
    try {
      const decoded = stream.decoder.decode(textBytes(delta), { stream: true })
      const joined = stream.tail + decoded
      match(joined, hits)
      // 74 code points, not 74 bytes; a multibyte character is never sliced in
      // half. Only this bounded tail survives between real stream chunks/pages.
      stream.tail = Array.from(joined.slice(-148)).slice(-74).join('')
    } catch { local.add('malformed_utf8') }
  }
  return { match, deep, chunk, reasons, finish() { if (streams.size) reasons.add('unclosed_stream'); streams.clear(); return [...reasons] } }
}

function attributes(category, raw) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'row')
  const keys = {
    chunks: ['seq'], messages: ['sequence'], checkpoint: ['files', 'unavailable', 'patchPresent', 'takenAt', 'updatedAt'],
    artifact_versions: ['artifactId', 'version', 'kind', 'contentBytes', 'contentSha256', 'createdAt'],
    captures: ['kind', 'contentType', 'status', 'contentBytes', 'contentSha256', 'updatedAt'],
    capture_steps: ['captureId', 'atMs'], run_definition: [],
  }[category]
  const result = Object.fromEntries(keys.map(key => [key, raw[key]]))
  check(Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key)), 'row')
  if (category === 'chunks') check(integer(result.seq), 'row')
  if (category === 'messages') check(/^\d+$/.test(result.sequence ?? ''), 'row')
  if (category === 'checkpoint') check(integer(result.files) && typeof result.unavailable === 'boolean'
    && typeof result.patchPresent === 'boolean', 'row')
  if (category === 'artifact_versions') check(UUID.test(result.artifactId ?? '') && integer(result.version) && result.version > 0
    && integer(result.contentBytes) && SHA.test(result.contentSha256 ?? ''), 'row')
  if (category === 'artifact_versions' && !['markdown', 'html'].includes(result.kind)) result.kind = 'unknown'
  if (category === 'captures') {
    check((result.contentBytes === null || integer(result.contentBytes))
    && (result.contentSha256 === null || SHA.test(result.contentSha256 ?? '')), 'row')
    if (!['image', 'video'].includes(result.kind)) result.kind = 'unknown'
    if (!['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'].includes(result.contentType)) result.contentType = 'unknown'
    if (!['recording', 'uploading', 'ready', 'failed'].includes(result.status)) result.status = 'unknown'
  }
  if (category === 'capture_steps') check(UUID.test(result.captureId ?? '') && integer(result.atMs), 'row')
  for (const key of ['takenAt', 'updatedAt', 'createdAt']) if (Object.hasOwn(result, key)) {
    check(typeof result[key] === 'string' && Number.isFinite(Date.parse(result[key])), 'row')
    result[key] = new Date(result[key]).toISOString()
  }
  return result
}

/** query(text, values, {signal, timeoutMs}) -> {rows}: a readonly, <=5s adapter.
 * client is the existing createSessionClient owner closure. The caller enters
 * its evidence budget phase before calling. saveObject receives only metadata
 * and scan receipts, never bytes. Limits can only be tightened, never raised.
 */
export async function collectTaskSecretEvidence({ query, client, scope, canaries, budget, saveObject, limits }) {
  const { cap, generations, values } = inputs({ scope, canaries, limits })
  check(typeof query === 'function' && typeof client?.request === 'function' && typeof saveObject === 'function'
    && typeof budget?.remaining === 'function' && typeof budget?.signal === 'function', 'configuration')
  const report = { version: 1, status: 'needs_collection', scope: { ownerHash: hash(scope.ownerId),
    workspaceId: scope.workspaceId, botId: scope.botId, issueId: scope.issueId, runId: scope.runId },
    canaries: { descriptor: { format: 'synthetic_task_secret_v1', byteLength: 75, encodings: ['utf8'] }, generations },
    startedAt: new Date().toISOString(), finishedAt: null, limits: cap, bytesRead: 0, inflatedBytes: 0,
    inventoryStable: false, categories: {}, objects: [], reasons: [], matchedObjects: 0,
    vmTranscript: { status: 'needs_collection', reason: 'no_existing_collector' } }
  const problems = new Set(), scan = scanner(generations, cap)
  for (const category of CATEGORIES) report.categories[category] = { status: 'needs_collection', observed: 0,
    pages: 0, verificationPages: 0, manifestSha256: null, scan: 'incomplete', reasons: [] }
  const call = (sql, parameters) => {
    time()
    return query(sql, parameters, { signal: budget.signal(), timeoutMs: budget.remaining('evidence', 5000) })
  }
  function time() { budget.remaining('evidence', 5000); check(!budget.signal().aborted, 'budget') }
  function take(length) {
    check(integer(length) && report.bytesRead + length <= cap.totalBytes, 'byte_limit')
    report.bytesRead += length
  }
  // This callback is bounded local receipt I/O, not another remote read. An
  // expired evidence deadline must not discard evidence already in memory.
  async function persist(object) {
    try { await saveObject(structuredClone(object)) } catch { problems.add('receipt_not_saved') }
  }
  async function readScope() {
    const { rows } = await call(SCOPE_QUERY, values)
    check(rows?.length === 1, 'scope_unverified')
    const row = rows[0]
    check(row.readOnly === 'on' && row.id === scope.runId && row.userId === scope.ownerId
      && row.workspaceId === scope.workspaceId && row.botId === scope.botId && row.issueId === scope.issueId
      && typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)), 'scope_unverified')
    for (const key of ['messageGaps', 'checkpointGaps', 'captureGaps', 'captureStepGaps', 'receiptGaps', 'artifactGaps']) check(integer(row[key]), 'scope_unverified')
    check(typeof row.status === 'string', 'scope_unverified')
    return row
  }
  async function fetchBody(category, id, attrs, hits, local) {
    if (attrs.kind === 'unknown' || attrs.contentType === 'unknown') { local.add('unsupported_object_type'); return null }
    if (category === 'captures') {
      local.add('visual_content_unscanned')
      if (attrs.status !== 'ready' || !integer(attrs.contentBytes) || !SHA.test(attrs.contentSha256 ?? '')) {
        local.add('object_not_ready'); return null
      }
    }
    if (attrs.contentBytes > cap.objectBytes || attrs.contentBytes > cap.totalBytes - report.bytesRead) {
      local.add('byte_limit'); return null
    }
    const path = category === 'artifact_versions'
      ? `/api/artifacts/${attrs.artifactId}/versions/${attrs.version}/download` : `/api/captures/${id}`
    let response, reader, done = false, size = 0, tail = '', sha256 = null
    const digest = createHash('sha256'), parts = []
    try {
      time()
      const timeoutMs = budget.remaining('evidence', 10_000)
      const signal = AbortSignal.any([budget.signal(), AbortSignal.timeout(timeoutMs)])
      response = await client.request(path, { method: 'GET', signal,
        headers: { 'x-mikka-workspace-id': scope.workspaceId, 'accept-encoding': 'identity' } }, timeoutMs)
      check(response.status === 200 && !response.redirected && response.body, 'object_read')
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.toLowerCase()
      check(contentType === (category === 'captures' ? attrs.contentType : attrs.kind === 'html' ? 'text/html' : 'text/markdown'), 'object_type')
      reader = response.body.getReader()
      while (!done) {
        time()
        const next = await reader.read(); done = next.done
        if (done) break
        check(next.value instanceof Uint8Array, 'object_read')
        size += next.value.byteLength
        check(size <= attrs.contentBytes && size <= cap.objectBytes, 'object_size')
        take(next.value.byteLength); digest.update(next.value)
        if (category === 'artifact_versions') parts.push(Buffer.from(next.value))
        else {
          const text = tail + Buffer.from(next.value).toString('latin1')
          scan.match(text, hits); tail = text.slice(-74)
        }
      }
      sha256 = digest.digest('hex')
      if (category === 'artifact_versions') scan.deep(utf8(Buffer.concat(parts)), hits, local)
      check(size === attrs.contentBytes && sha256 === attrs.contentSha256, 'object_hash')
      return { bytes: size, sha256, verified: true }
    } catch (cause) {
      const code = cause?.message
      local.add(['task_secrets_evidence_object_type', 'task_secrets_evidence_object_size', 'task_secrets_evidence_object_hash',
        'task_secrets_evidence_byte_limit'].includes(code) ? code.slice('task_secrets_evidence_'.length) : 'object_read_failed')
      return { bytes: size, sha256, verified: false }
    } finally {
      if (!done) {
        if (reader) await reader.cancel().catch(() => {})
        else await response?.body?.cancel().catch(() => {})
      }
      reader?.releaseLock()
    }
  }
  async function visit(category, row, attrs) {
    const hits = new Set(), local = new Set()
    const receipt = { category, id: row.id, cursor: row.cursor, attributes: attrs,
      bytes: row.rawBytes, sha256: row.rawSha256, content: null, inventoryStable: false,
      inventoryStatus: 'pending_verification',
      scan: { status: 'incomplete', matchedGenerations: [], reasons: [] } }
    if (category === 'checkpoint' && !attrs.patchPresent) {
      local.add('patch_unavailable')
      if (attrs.unavailable) local.add('checkpoint_unavailable')
    } else try {
      check(row.rawBytes <= cap.objectBytes && row.body instanceof Uint8Array && row.body.byteLength === row.rawBytes
        && hash(row.body) === row.rawSha256, 'row_bytes')
      take(row.rawBytes)
      scan.match(Buffer.from(row.body).toString('latin1'), hits)
      if (category === 'checkpoint') {
        if (attrs.unavailable) local.add('checkpoint_unavailable')
        let bytes = Buffer.from(row.body)
        if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
          try {
            check(report.inflatedBytes < cap.inflatedBytes, 'inflated_limit')
            bytes = gunzipSync(bytes, { maxOutputLength: cap.inflatedBytes - report.inflatedBytes })
            report.inflatedBytes += bytes.length
            receipt.inflated = { bytes: bytes.length, sha256: hash(bytes) }
          } catch { local.add('gzip_unscanned'); bytes = null }
        }
        if (bytes) {
          const text = utf8(bytes)
          scan.deep(text, hits, local)
          if (/^GIT binary patch\r?$/m.test(text)) local.add('git_binary_unscanned')
        }
      } else {
        const value = JSON.parse(utf8(row.body))
        if (category === 'chunks') scan.chunk(value, hits, local)
        else scan.deep(value, hits, local)
      }
    } catch { local.add(row.body === null ? 'byte_limit' : 'malformed_or_unread_body') }
    if (category === 'artifact_versions' || category === 'captures') receipt.content = await fetchBody(category, row.id, attrs, hits, local)
    receipt.scan = { status: hits.size ? 'matched' : local.size ? 'incomplete' : 'no_match_in_text',
      matchedGenerations: [...hits].sort((a, b) => a - b), reasons: [...local].sort() }
    return receipt
  }
  async function enumerate(category, collect) {
    const info = report.categories[category], manifest = createHash('sha256')
    let cursor = null, count = 0, previousSeq
    for (let page = 0; page < cap.pagesPerCategory; page++) {
      time()
      const { rows } = await call(pageQuery(category), [...values, cursor, cap.pageSize, collect, cap.objectBytes,
        Math.max(0, cap.totalBytes - report.bytesRead)])
      check(Array.isArray(rows) && rows.length <= cap.pageSize, 'page')
      info[collect ? 'pages' : 'verificationPages']++
      for (const row of rows) {
        time()
        const missingPatch = category === 'checkpoint' && row.rawBytes === null && row.rawSha256 === null && row.body === null
        check(UUID.test(row.id ?? '') && (missingPatch || integer(row.rawBytes) && SHA.test(row.rawSha256 ?? '')), 'row')
        const numeric = SOURCES[category].cursor === 'bigint'
        check(typeof row.cursor === 'string' && (numeric ? /^\d+$/.test(row.cursor) : UUID.test(row.cursor)), 'cursor')
        check(cursor === null || (numeric ? BigInt(row.cursor) > BigInt(cursor) : row.cursor > cursor), 'cursor')
        const attrs = attributes(category, row.attributes)
        if (category === 'checkpoint') check(attrs.patchPresent !== missingPatch, 'row')
        if (category === 'chunks') {
          check(String(attrs.seq) === row.cursor, 'cursor')
          if (previousSeq !== undefined && attrs.seq !== previousSeq + 1) info.reasons.push('chunk_sequence_gap')
          previousSeq = attrs.seq
        }
        const projected = { id: row.id, cursor: row.cursor, attributesSha256: hash(JSON.stringify(row.attributes)),
          bytes: row.rawBytes, sha256: row.rawSha256 }
        manifest.update(JSON.stringify(projected) + '\n')
        cursor = row.cursor; count++
        check(count <= cap.objects && (!collect || report.objects.length < cap.objects), 'object_limit')
        if (collect) {
          info.observed = count
          const object = await visit(category, row, attrs)
          report.objects.push(object)
          await persist(object)
        }
      }
      if (rows.length < cap.pageSize) return { count, sha256: manifest.digest('hex') }
    }
    throw Error('task_secrets_evidence_page_limit')
  }
  let initial
  try { initial = await readScope() } catch { problems.add('scope_unverified') }
  if (initial) {
    if (!TERMINAL.has(initial.status)) problems.add('run_not_ended')
    const inventories = new Map()
    for (const category of CATEGORIES) {
      const info = report.categories[category]
      try {
        const collected = await enumerate(category, true)
        info.observed = collected.count; info.manifestSha256 = collected.sha256
        if (category === 'run_definition' && collected.count !== 1) info.reasons.push('run_definition_unavailable')
        inventories.set(category, collected)
      } catch (cause) {
        info.reasons.push(['task_secrets_evidence_page_limit', 'task_secrets_evidence_object_limit', 'task_secrets_evidence_cursor']
          .includes(cause?.message) ? cause.message.slice('task_secrets_evidence_'.length) : 'enumeration_failed')
        info.status = 'incomplete'
      }
    }
    report.categories.chunks.reasons.push(...scan.finish())
    // Re-enumerate every manifest after all content I/O, not immediately after
    // each category. This is an explicit two-observation check, not a claim of
    // a database snapshot spanning HTTP or of excluding later writes forever.
    for (const [category, collected] of inventories) {
      const info = report.categories[category]
      try {
        const verified = await enumerate(category, false)
        if (verified.count !== collected.count || verified.sha256 !== collected.sha256) info.reasons.push('inventory_changed')
        info.status = info.reasons.length ? 'incomplete' : collected.count ? 'collected' : 'observed_zero'
      } catch { info.reasons.push('verification_failed'); info.status = 'incomplete' }
    }
    let final
    try { final = await readScope() } catch { problems.add('scope_unverified') }
    if (final && JSON.stringify(initial) !== JSON.stringify(final)) problems.add('scope_or_inventory_changed')
    for (const row of [initial, final].filter(Boolean)) {
      const gaps = { messages: row.messageGaps, checkpoint: row.checkpointGaps, captures: row.captureGaps,
        capture_steps: row.captureStepGaps, artifact_versions: row.receiptGaps + row.artifactGaps }
      for (const [category, count] of Object.entries(gaps)) if (count) report.categories[category].reasons.push('provenance_gap')
    }
  }
  report.inventoryStable = initial !== undefined && problems.size === 0
    && CATEGORIES.every(category => !report.categories[category].reasons.length)
  for (const category of CATEGORIES) {
    const info = report.categories[category], objects = report.objects.filter(object => object.category === category)
    info.reasons = [...new Set(info.reasons)].sort()
    const incomplete = problems.size || info.reasons.length || ['needs_collection', 'incomplete'].includes(info.status)
    if (incomplete) info.status = 'incomplete'
    info.scan = objects.some(object => object.scan.status === 'matched') ? 'matched'
      : incomplete || objects.some(object => object.scan.status === 'incomplete') ? 'incomplete'
        : objects.length ? 'no_match_in_complete_text' : 'observed_zero'
    for (const object of objects) {
      object.inventoryStable = !incomplete
      object.inventoryStatus = incomplete ? 'incomplete' : 'verified'
      if (object.scan.matchedGenerations.length) report.matchedObjects++
      await persist(object)
    }
  }
  report.reasons = [...problems].sort()
  report.status = report.matchedObjects ? 'leak_detected' : 'needs_collection'
  report.serverEvidence = { status: report.inventoryStable && !problems.size
    && CATEGORIES.every(category => ['observed_zero', 'no_match_in_complete_text'].includes(report.categories[category].scan))
    ? 'complete_text_scan' : 'incomplete', coveredCategories: [...CATEGORIES],
    coverageGaps: [
      { category: 'coordinator_messages', status: 'needs_collection', reason: 'bot_spans_multiple_cases' },
      { category: 'coordinator_events_except_artifact_receipts', status: 'needs_collection', reason: 'not_collected' },
      { category: 'vm_transcript', status: 'needs_collection', reason: 'no_existing_collector' },
    ], observedZeroMeans: 'no_rows_observed_not_feature_exercised',
    atomicSnapshot: false, revalidatedEnumeration: report.inventoryStable }
  report.finishedAt = new Date().toISOString()
  return report
}

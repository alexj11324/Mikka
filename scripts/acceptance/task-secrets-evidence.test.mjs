import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { collectTaskSecretEvidence, TASK_SECRET_EVIDENCE_LIMITS } from './task-secrets-evidence.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = '2026-11-09T00:00:00.000Z'
const scope = { ownerId: 'synthetic-verified-owner', workspaceId: id(1), botId: id(2), issueId: id(3), runId: id(4) }
const values = [scope.ownerId, scope.workspaceId, scope.botId, scope.issueId, scope.runId]
const tokens = ['a', 'b', 'c'].map(char => 'mikka1712s_' + char.repeat(64))
const canaries = { descriptor: { format: 'synthetic_task_secret_v1', byteLength: 75, encodings: ['utf8'] },
  generations: tokens.map((token, index) => ({ generation: index + 1, sha256: sha(token),
    state: ['prepared', 'outcome_unknown', 'acknowledged'][index] })) }
const scopeRow = () => ({ id: scope.runId, userId: scope.ownerId, workspaceId: scope.workspaceId,
  botId: scope.botId, issueId: scope.issueId, status: 'stopped', updatedAt: at, readOnly: 'on',
  messageGaps: 0, checkpointGaps: 0, captureGaps: 0, captureStepGaps: 0, receiptGaps: 0, artifactGaps: 0 })

function row(n, value, attributes = {}, cursor = id(n)) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
  return { id: id(n), cursor, attributes, rawBytes: body.length, rawSha256: sha(body), body }
}
const chunk = (seq, value) => row(100 + seq, value, { seq }, String(seq))
const message = (n, value) => row(n, value, { sequence: String(n) }, String(n))
const checkpoint = bytes => row(4, bytes, { files: 1, unavailable: false, patchPresent: true, takenAt: at, updatedAt: at })
function artifact(n, body, overrides = {}) {
  return row(n, { title: 'Synthetic evidence', authorName: 'Synthetic worker', executionIdentity: null },
    { artifactId: id(n + 1000), version: 1, kind: 'markdown', contentBytes: body.length,
      contentSha256: sha(body), createdAt: at, ...overrides })
}
function capture(n, bytes, overrides = {}) {
  return row(n, { title: 'Synthetic capture', error: null, source: 'local' },
    { kind: 'image', contentType: 'image/png', status: 'ready', contentBytes: bytes.length,
      contentSha256: sha(bytes), updatedAt: at, ...overrides })
}

function fixture(data = {}, options = {}) {
  data = { run_definition: [row(4, { prompt: 'Synthetic task', agentDefinition: {} })], ...data }
  const calls = [], requests = [], saved = [], controller = new AbortController()
  const categoryCalls = new Map()
  let scopeReads = 0
  const budget = { remaining(kind, max) { assert.equal(kind, 'evidence'); return max }, signal: () => controller.signal }
  const query = async (sql, parameters, control) => {
    assert.deepEqual(parameters.slice(0, 5), values)
    assert.equal(control.signal, controller.signal)
    assert.ok(control.timeoutMs > 0 && control.timeoutMs <= 5000)
    assert.match(sql, /r\."userId"=\$1/)
    assert.match(sql, /r\."workspaceId"=\$2::uuid/)
    assert.match(sql, /r\."botId"=\$3::uuid/)
    assert.match(sql, /r\."issueId"=\$4::uuid/)
    assert.match(sql, /r\.id=\$5::uuid/)
    assert.match(sql, /b\.id=r\."botId" AND b\."ownerId"=r\."userId" AND b\."workspaceId"=r\."workspaceId"/)
    assert.match(sql, /i\."workspaceId"=r\."workspaceId" AND i\."ownershipState"='bound'/)
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|COPY|FOR SHARE|FOR UPDATE)\b/i)
    const category = /task-secret-evidence:(\w+)/.exec(sql)[1]
    calls.push({ category, parameters, sql })
    if (category === 'scope') return { rows: options.scope ? options.scope(++scopeReads) : [scopeRow()] }
    assert.match(sql, /ORDER BY position LIMIT \$7::integer/)
    assert.match(sql, /sum\(octet_length\(payload\)\).*\$10::bigint/)
    const count = (categoryCalls.get(category) ?? 0) + 1; categoryCalls.set(category, count)
    if (options.queryError?.(category, count)) throw Error('synthetic private body must never escape')
    const [cursor, size, collect, objectLimit, byteLimit] = parameters.slice(5)
    const numeric = ['chunks', 'messages'].includes(category)
    let rows = (data[category] ?? []).filter(item => cursor === null ||
      (numeric ? BigInt(item.cursor) > BigInt(cursor) : item.cursor > cursor)).slice(0, size)
    if (options.rows) rows = options.rows(category, collect, rows)
    let bytes = 0
    return { rows: rows.map(item => {
      bytes += item.rawBytes
      return { ...item, body: collect && bytes <= byteLimit && item.rawBytes <= objectLimit ? item.body : null }
    }) }
  }
  const client = { async request(path, init, timeoutMs) {
    requests.push(path)
    assert.equal(init.method, 'GET'); assert.equal(init.headers['x-mikka-workspace-id'], scope.workspaceId)
    assert.equal(init.headers['accept-encoding'], 'identity')
    assert.ok(init.signal instanceof AbortSignal && timeoutMs <= 10_000)
    const spec = options.http?.[path]
    assert.ok(spec, 'only the precise existing owner download endpoint may be requested')
    if (typeof spec === 'function') return spec()
    return new Response(spec.body, { status: spec.status ?? 200, headers: { 'content-type': spec.type } })
  } }
  return { calls, requests, saved, controller,
    run: extra => collectTaskSecretEvidence({ query, client, scope, canaries, budget,
      saveObject: async object => {
        saved.push(object); options.afterSave?.(object, controller)
        if (options.saveError) throw Error('private save failure')
      }, ...extra }) }
}

test('empty bounded categories are observed_zero; VM evidence and overall completion stay open', async () => {
  const f = fixture(), result = await f.run()
  assert.equal(result.serverEvidence.status, 'complete_text_scan')
  assert.equal(result.inventoryStable, true)
  assert.equal(result.status, 'needs_collection')
  assert.equal(result.vmTranscript.status, 'needs_collection')
  for (const [category, value] of Object.entries(result.categories)) {
    if (category === 'run_definition') { assert.equal(value.status, 'collected'); continue }
    assert.equal(value.status, 'observed_zero'); assert.equal(value.scan, 'observed_zero')
    assert.equal(value.pages, 1); assert.equal(value.verificationPages, 1)
  }
  assert.equal(f.requests.length, 0)
})

test('each scope binding and readonly status must be proven before object reads', async () => {
  for (const field of ['userId', 'workspaceId', 'botId', 'issueId', 'id', 'readOnly']) {
    const f = fixture({}, { scope: () => [{ ...scopeRow(), [field]: 'foreign' }] }), result = await f.run()
    assert.equal(result.serverEvidence.status, 'incomplete')
    assert.deepEqual(result.reasons, ['scope_unverified'])
    assert.equal(f.calls.length, 1); assert.equal(f.requests.length, 0)
  }
  const f = fixture({}, { scope: () => [] })
  assert.equal((await f.run()).inventoryStable, false)
})

test('all generation hashes, including prepared and outcome_unknown, are scanned without exporting values', async () => {
  const f = fixture({ messages: tokens.map((token, n) => message(10 + n, { text: token })) })
  const result = await f.run()
  assert.equal(result.status, 'leak_detected'); assert.equal(result.matchedObjects, 3)
  assert.deepEqual(result.objects.filter(object => object.category === 'messages').map(object => object.scan.matchedGenerations), [[1], [2], [3]])
  const serialized = JSON.stringify({ result, saved: f.saved })
  for (const token of tokens) assert.ok(!serialized.includes(token))
  assert.ok(!serialized.includes(scope.ownerId))
  assert.ok(result.objects.every(object => !Object.hasOwn(object, 'body')))
})

test('JSON escapes and nested serialized tool input are decoded before scanning', async () => {
  const escaped = '\\u006d' + tokens[0].slice(1)
  const bytes = Buffer.from('{"text":' + JSON.stringify('{"token":"' + escaped + '"}') + '}')
  const f = fixture({ messages: [message(10, bytes)] }), result = await f.run()
  assert.deepEqual(result.objects[0].scan.matchedGenerations, [1])
})

test('real stream identities retain unicode-safe tails across pages and do not combine other streams', async () => {
  const target = tokens[1], data = [
    { type: 'text-start', id: 'a' },
    { type: 'text-delta', id: 'a', delta: '😀'.repeat(100) + target.slice(0, 40) },
    { type: 'text-start', id: 'b' },
    { type: 'text-delta', id: 'b', delta: target.slice(40) },
    { type: 'text-delta', id: 'a', delta: target.slice(40) },
    { type: 'text-end', id: 'a' }, { type: 'text-end', id: 'b' },
  ]
  const f = fixture({ chunks: data.map((value, seq) => chunk(seq, value)) })
  const result = await f.run({ limits: { pageSize: 2 } })
  assert.equal(result.categories.chunks.pages, 4)
  assert.deepEqual(result.objects[4].scan.matchedGenerations, [2])
  assert.equal(result.objects[3].scan.status, 'no_match_in_text')
  assert.equal(result.categories.chunks.status, 'collected')
})

test('reasoning and tool-input streams are reconstructed separately', async () => {
  const data = [
    { type: 'reasoning-start', id: 'same' }, { type: 'tool-input-start', toolCallId: 'same' },
    { type: 'reasoning-delta', id: 'same', delta: tokens[0].slice(0, 20) },
    { type: 'tool-input-delta', toolCallId: 'same', inputTextDelta: tokens[2].slice(0, 30) },
    { type: 'reasoning-delta', id: 'same', delta: tokens[0].slice(20) },
    { type: 'tool-input-delta', toolCallId: 'same', inputTextDelta: tokens[2].slice(30) },
    { type: 'reasoning-end', id: 'same' }, { type: 'tool-input-available', toolCallId: 'same', input: {} },
  ]
  const result = await fixture({ chunks: data.map((value, seq) => chunk(seq, value)) }).run()
  assert.deepEqual(result.objects[4].scan.matchedGenerations, [1])
  assert.deepEqual(result.objects[5].scan.matchedGenerations, [3])
})

test('malformed, unsupported, missing-start, unclosed and gapped streams cannot claim a clean scan', async () => {
  const cases = [
    [chunk(0, { type: 'text-delta', id: 'missing', delta: 'x' })],
    [chunk(0, { type: 'unknown-delta', delta: 'x' })],
    [chunk(0, { type: 'text-start', id: 'x' })],
    [chunk(0, { type: 'text-start', id: 'x' }), chunk(1, { type: 'text-delta', id: 'x', delta: '\ud800' }), chunk(2, { type: 'text-end', id: 'x' })],
    [chunk(0, { type: 'start' }), chunk(2, { type: 'finish' })],
  ]
  for (const chunks of cases) {
    const result = await fixture({ chunks }).run()
    assert.equal(result.serverEvidence.status, 'incomplete')
    assert.equal(result.categories.chunks.scan, 'incomplete')
  }
})

test('gzip checkpoints are scanned after inflation with both byte hashes', async () => {
  const plain = Buffer.from('diff --git a/config b/config\n+' + tokens[2] + '\n')
  const result = await fixture({ checkpoint: [checkpoint(gzipSync(plain))] }).run()
  assert.equal(result.status, 'leak_detected')
  assert.deepEqual(result.objects[0].inflated, { bytes: plain.length, sha256: sha(plain) })
  assert.deepEqual(result.objects[0].scan.matchedGenerations, [3])
})

test('gzip failure, inflated-size limits, non-UTF8, binary patches and unavailable checkpoints stay incomplete', async () => {
  const cases = [checkpoint(Buffer.from([0x1f, 0x8b, 0x00])), checkpoint(Buffer.from([0xff, 0xfe])),
    checkpoint(gzipSync(Buffer.from('GIT binary patch\nliteral 100\nencoded\n'))),
    { ...checkpoint(Buffer.from('')), attributes: { files: 0, unavailable: true, patchPresent: true, takenAt: at, updatedAt: at } }]
  for (const value of cases) assert.equal((await fixture({ checkpoint: [value] }).run()).categories.checkpoint.scan, 'incomplete')
  const result = await fixture({ checkpoint: [checkpoint(gzipSync(Buffer.alloc(100, 97)))] }).run({ limits: { inflatedBytes: 10 } })
  assert.ok(result.objects[0].scan.reasons.includes('gzip_unscanned'))
})

test('all submitted versions use exact authenticated download paths and verified SHA/size', async () => {
  const body = Buffer.from('# ' + tokens[0]), a = artifact(20, body), b = artifact(21, body, { artifactId: a.attributes.artifactId, version: 2 })
  const http = Object.fromEntries([a, b].map(item => [`/api/artifacts/${item.attributes.artifactId}/versions/${item.attributes.version}/download`,
    { body, type: 'text/markdown; charset=utf-8' }]))
  const f = fixture({ artifact_versions: [a, b] }, { http }), result = await f.run()
  assert.equal(f.requests.length, 2)
  assert.equal(result.matchedObjects, 2)
  assert.ok(result.objects.filter(object => object.category === 'artifact_versions').every(object => object.content.verified && object.content.sha256 === sha(body)))
  const sql = f.calls.find(call => call.category === 'artifact_versions').sql
  assert.match(sql, /e\."runId"=s\.id AND e\."userId"=s\."userId"/)
  assert.match(sql, /a\."workspaceId"=s\."workspaceId"/)
  assert.match(sql, /e\."dedupeKey"='artifact_submitted:'/)
  assert.doesNotMatch(sql, /latestVersion/)
})

test('missing version provenance is a gap, never permission to read its body or report zero', async () => {
  const f = fixture({}, { scope: () => [{ ...scopeRow(), artifactGaps: 1, receiptGaps: 1 }] }), result = await f.run()
  assert.equal(result.categories.artifact_versions.status, 'incomplete')
  assert.ok(result.categories.artifact_versions.reasons.includes('provenance_gap'))
  assert.equal(f.requests.length, 0)
})

test('images and video bytes can be accounted for but never provide negative visual evidence', async () => {
  const body = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), c = capture(30, body)
  const f = fixture({ captures: [c] }, { http: { [`/api/captures/${c.id}`]: { body, type: 'image/png' } } })
  const result = await f.run()
  assert.equal(result.objects[0].content.verified, true)
  assert.deepEqual(result.objects[0].scan.reasons, ['visual_content_unscanned'])
  assert.equal(result.categories.captures.scan, 'incomplete')
  assert.equal(result.serverEvidence.status, 'incomplete')
})

test('unknown media, nonready captures and capture-step text are explicitly accounted for', async () => {
  const unknown = capture(30, Buffer.from(''), { contentType: 'arbitrary-private-value' })
  const pending = capture(31, Buffer.from(''), { status: 'uploading', contentBytes: null, contentSha256: null })
  const f = fixture({ captures: [unknown, pending], capture_steps: [row(40, { label: tokens[1], source: 'mark' }, { captureId: id(30), atMs: 0 })] })
  const result = await f.run()
  assert.equal(f.requests.length, 0)
  assert.equal(result.status, 'leak_detected')
  assert.equal(result.categories.captures.observed, 2)
  assert.equal(result.objects[0].attributes.contentType, 'unknown')
  assert.ok(!JSON.stringify(result).includes('arbitrary-private-value'))
})

test('HTTP rejection, unexpected MIME, partial response and digest mismatch stay incomplete', async () => {
  const body = Buffer.from('expected'), a = artifact(20, body), path = `/api/artifacts/${a.attributes.artifactId}/versions/1/download`
  for (const spec of [
    { body: '', type: 'text/markdown', status: 403 }, { body, type: 'application/octet-stream' },
    { body: 'short', type: 'text/markdown' }, { body: 'modified', type: 'text/markdown' },
  ]) {
    const result = await fixture({ artifact_versions: [a] }, { http: { [path]: spec } }).run()
    assert.equal(result.categories.artifact_versions.scan, 'incomplete')
    assert.equal(result.objects[0].content.verified, false)
  }
})

test('byte/page/object limits preserve positive partial evidence instead of returning a clean truncated list', async () => {
  const messages = [message(10, { text: tokens[0] }), message(11, { text: 'x' })]
  const page = await fixture({ messages }).run({ limits: { pageSize: 1, pagesPerCategory: 1 } })
  assert.equal(page.status, 'leak_detected'); assert.equal(page.objects.filter(object => object.category === 'messages').length, 1)
  assert.ok(page.categories.messages.reasons.includes('page_limit'))
  const objects = await fixture({ messages }).run({ limits: { objects: 1 } })
  assert.equal(objects.status, 'leak_detected'); assert.ok(objects.categories.messages.reasons.includes('object_limit'))
  const bytes = await fixture({ messages }).run({ limits: { totalBytes: 10 } })
  assert.equal(bytes.categories.messages.scan, 'incomplete')
  assert.equal(bytes.bytesRead, 0)
})

test('per-page verification and final scope changes invalidate an apparently clean scan without retrying', async () => {
  const changed = await fixture({ messages: [message(10, { text: 'initial' })] }, {
    rows: (category, collect, rows) => category === 'messages' && !collect ? [message(10, { text: 'changed' })] : rows,
  }).run()
  assert.ok(changed.categories.messages.reasons.includes('inventory_changed'))
  const scopeChanged = await fixture({}, { scope: call => [{ ...scopeRow(), updatedAt: call === 1 ? at : '2026-11-09T00:00:01.000Z' }] }).run()
  assert.ok(scopeChanged.reasons.includes('scope_or_inventory_changed'))
  assert.equal(scopeChanged.inventoryStable, false)
})

test('query and save failures remain bounded, sanitized gaps; no aborted work begins', async () => {
  const f = fixture({ messages: [message(10, { text: tokens[0] })] }, { queryError: (category, count) => category === 'messages' && count === 2 })
  const failed = await f.run()
  assert.equal(failed.status, 'leak_detected')
  assert.ok(failed.categories.messages.reasons.includes('verification_failed'))
  assert.ok(!JSON.stringify(failed).includes('synthetic private'))
  const saved = await fixture({ messages: [message(10, { text: 'safe' })] }, { saveError: true }).run()
  assert.ok(saved.reasons.includes('receipt_not_saved')); assert.equal(saved.serverEvidence.status, 'incomplete')
  const aborted = fixture(); aborted.controller.abort()
  assert.equal((await aborted.run()).serverEvidence.status, 'incomplete')
  assert.equal(aborted.calls.length, 0)
})

test('invalid descriptors or larger limits fail before querying or authenticated HTTP', async () => {
  const f = fixture()
  await assert.rejects(f.run({ canaries: { ...canaries, descriptor: { ...canaries.descriptor, encodings: ['base64'] } } }), /canaries/)
  await assert.rejects(f.run({ limits: { pageSize: TASK_SECRET_EVIDENCE_LIMITS.pageSize + 1 } }), /limits/)
  assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0)
})

test('a NULL unavailable checkpoint preserves its exact inventory row and explicit unread state', async () => {
  const value = { ...checkpoint(Buffer.alloc(0)), rawBytes: null, rawSha256: null, body: null,
    attributes: { files: 0, unavailable: true, patchPresent: false, takenAt: at, updatedAt: at } }
  const f = fixture({ checkpoint: [value] }), result = await f.run()
  assert.equal(result.categories.checkpoint.observed, 1)
  assert.equal(result.categories.checkpoint.status, 'collected')
  assert.equal(result.categories.checkpoint.scan, 'incomplete')
  const object = result.objects.find(item => item.category === 'checkpoint')
  assert.equal(object.bytes, null); assert.equal(object.sha256, null)
  assert.deepEqual(object.scan.reasons, ['checkpoint_unavailable', 'patch_unavailable'])
  assert.equal(f.saved.find(item => item.category === 'checkpoint').id, scope.runId)
  assert.ok(!result.categories.checkpoint.reasons.includes('enumeration_failed'))
})

test('the exact Run prompt and definition are scanned; coverage names every category and remaining gap', async () => {
  const f = fixture({ run_definition: [row(4, { prompt: tokens[0], agentDefinition: { instructions: tokens[1] } })] })
  const result = await f.run(), object = result.objects.find(item => item.category === 'run_definition')
  assert.deepEqual(object.scan.matchedGenerations, [1, 2])
  assert.equal(result.status, 'leak_detected')
  assert.deepEqual(result.serverEvidence.coveredCategories,
    ['chunks', 'messages', 'checkpoint', 'artifact_versions', 'captures', 'capture_steps', 'run_definition'])
  assert.deepEqual(result.serverEvidence.coverageGaps.map(gap => gap.category),
    ['coordinator_messages', 'coordinator_events_except_artifact_receipts', 'vm_transcript'])
  assert.equal(result.serverEvidence.observedZeroMeans, 'no_rows_observed_not_feature_exercised')
  assert.match(f.calls.find(call => call.category === 'run_definition').sql, /'prompt',r\.prompt,'agentDefinition',r\."agentDefinition"/)
  assert.ok(tokens.every(token => !JSON.stringify(result).includes(token)))
  const absent = await fixture({ run_definition: [] }).run()
  assert.ok(absent.categories.run_definition.reasons.includes('run_definition_unavailable'))
  assert.equal(absent.serverEvidence.status, 'incomplete')
})

test('pending receipts survive a mid-page deadline and final incomplete metadata still lands after abort', async () => {
  const f = fixture({ messages: [message(10, { text: tokens[0] }), message(11, { text: 'not reached' })] }, {
    afterSave: (object, controller) => { if (object.inventoryStatus === 'pending_verification') controller.abort() },
  })
  const result = await f.run()
  assert.equal(result.status, 'leak_detected')
  assert.equal(result.categories.messages.observed, 1)
  assert.equal(f.saved.length, 2)
  assert.equal(f.saved[0].id, id(10)); assert.equal(f.saved[1].id, id(10))
  assert.equal(f.saved[0].inventoryStatus, 'pending_verification')
  assert.equal(f.saved[0].inventoryStable, false)
  assert.equal(f.saved[1].inventoryStatus, 'incomplete')
  assert.deepEqual(f.saved[1].scan.matchedGenerations, [1])
  assert.equal(result.serverEvidence.status, 'incomplete')
  assert.ok(tokens.every(token => !JSON.stringify(f.saved).includes(token)))
})

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'
import { TARGET, ROUTES, validateExecution, validateSource, validateToken, validateIncident,
  validateOccurrences, guardianClient, dispose, inspectIncident, inspectOccurrences, inspect } from './gitguardian-37068506.mjs'

const clone = value => structuredClone(value)
const code = expected => error => error.code === expected && error.message === expected
const head = 'a'.repeat(40)
const execution = () => ({
  env: { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: TARGET.repository,
    GITHUB_REPOSITORY_ID: String(TARGET.repositoryId), GITHUB_REPOSITORY_OWNER_ID: String(TARGET.ownerId),
    GITHUB_REF: TARGET.ref, GITHUB_ACTOR: 'alexj11324', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head },
  event: { repository: { full_name: TARGET.repository, id: TARGET.repositoryId, owner: { id: TARGET.ownerId }, fork: false },
    ref: TARGET.ref, after: head, deleted: false, forced: false },
  head, parent: TARGET.base,
  changed: ['.github/workflows/gitguardian-37068506.yml', 'scripts/ops/gitguardian-37068506.mjs',
    'scripts/ops/gitguardian-37068506.test.mjs'],
})
const token = () => ({ workspace_id: TARGET.workspace, status: 'active', revoked_at: null, expire_at: null,
  scopes: ['incidents:read', 'incidents:write'] })
const incident = (status = 'TRIGGERED') => ({ id: TARGET.incident, occurrences_count: 3,
  detector: { display_name: 'Generic Password' },
  gitguardian_url: `https://dashboard.gitguardian.com/workspace/${TARGET.workspace}/incidents/${TARGET.incident}`,
  occurrences: [], status, ignore_reason: status === 'IGNORED' ? 'false_positive' : null })
const occurrences = () => TARGET.lines.map((line, i) => ({ id: 100 + i, incident_id: TARGET.incident,
  sha: TARGET.source, filepath: TARGET.file, change_type: 'addition',
  source: { id: 10, type: 'github', full_name: TARGET.repository, url: `https://github.com/${TARGET.repository}`,
    external_id: String(TARGET.repositoryId) },
  matches: [{ name: 'password', post_line_start: line, post_line_end: line }],
}))
const report = () => ({ result: 'blocked', writeAttempts: 0 })

test('only the reviewed repository, actor, new branch revision and exact three-file change can run', () => {
  assert.equal(validateExecution(execution()).checkout, head)
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'false', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'someone/Mikka', GITHUB_REPOSITORY_ID: '1', GITHUB_REPOSITORY_OWNER_ID: '1',
    GITHUB_REF: 'refs/heads/main', GITHUB_ACTOR: 'other', GITHUB_RUN_ATTEMPT: '2' })) {
    const input = execution(); input.env[key] = value
    assert.throws(() => validateExecution(input), code('EXECUTION_SCOPE'), key)
  }
  for (const mutate of [
    input => { input.event.repository.fork = true },
    input => { input.event.repository.id = 1 },
    input => { input.event.repository.owner.id = 1 },
    input => { input.event.repository.full_name = 'someone/Mikka' },
    input => { input.event.ref = 'refs/pull/1/merge' },
    input => { input.event.after = 'b'.repeat(40) },
    input => { input.env.GITHUB_SHA = 'b'.repeat(40) },
    input => { input.event.forced = true },
    input => { input.event.deleted = true },
  ]) {
    const input = execution(); mutate(input)
    assert.throws(() => validateExecution(input), code('EVENT_SCOPE'))
  }
  for (const mutate of [
    input => { input.parent = 'b'.repeat(40) },
    input => { input.changed.push('.gitguardian.yaml') },
    input => { input.changed[0] = 'apps/desktop/src/index.tsx' },
  ]) {
    const input = execution(); mutate(input)
    assert.throws(() => validateExecution(input), code('SOURCE_SCOPE'))
  }
})

test('the real fixed public blob contains required environment expressions at all three findings', () => {
  // CI fetches this one public revision before tests. Do not duplicate the Compose
  // source in this test or create new scanner occurrences of the same example.
  const body = execFileSync('git', ['show', `${TARGET.source}:${TARGET.file}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  assert.deepEqual(validateSource(body), { revision: TARGET.source, path: TARGET.file, blob: TARGET.blob, lines: [13, 14, 33] })
  assert.throws(() => validateSource(Buffer.concat([body, Buffer.from('\n')])), code('SOURCE_BLOB'))
})

test('token self metadata must identify the existing active workspace with read and write incident scopes', () => {
  validateToken(token())
  for (const change of [{ workspace_id: 1 }, { status: 'revoked' }, { revoked_at: '2026-01-01T00:00:00Z' },
    { expire_at: '2020-01-01T00:00:00Z' }, { expire_at: 'invalid' }]) {
    assert.throws(() => validateToken({ ...token(), ...change }), code('TOKEN_WORKSPACE_OR_STATUS'))
  }
  assert.throws(() => validateToken({ ...token(), scopes: ['incidents:read'] }), code('TOKEN_SCOPE'))
})

test('incident metadata rejects changed target, scope, embedded occurrence payload or disposition', () => {
  assert.equal(validateIncident(incident()).status, 'TRIGGERED')
  assert.equal(validateIncident(incident('IGNORED')).ignoreReason, 'false_positive')
  for (const change of [{ id: 1 }, { occurrences_count: 4 }, { detector: { display_name: 'Other' } },
    { gitguardian_url: 'https://dashboard.gitguardian.com/workspace/1/incidents/37068506' }]) {
    assert.throws(() => validateIncident({ ...incident(), ...change }), code('INCIDENT_SCOPE'))
  }
  assert.throws(() => validateIncident({ ...incident(), occurrences: [{}] }), code('INCIDENT_PROJECTION'))
  assert.throws(() => validateIncident({ ...incident(), status: 'RESOLVED' }), code('INCIDENT_STATUS'))
  assert.throws(() => validateIncident({ ...incident('IGNORED'), ignore_reason: 'test_credential' }), code('INCIDENT_REASON'))
  assert.throws(() => validateIncident({ ...incident(), ignore_reason: 'untrusted-provider-text' }), code('INCIDENT_REASON'))
})

test('all three occurrences must be in the exact repo, source revision, file and known public expression lines', () => {
  const headers = new Headers()
  assert.deepEqual(validateOccurrences(occurrences(), headers), [100, 101, 102])
  const normalized = occurrences()
  for (const row of normalized) {
    row.source.full_name = TARGET.repository.toLowerCase()
    row.source.url = `https://github.com/${TARGET.repository.toLowerCase()}`
  }
  assert.deepEqual(validateOccurrences(normalized, headers), [100, 101, 102])
  for (const mutate of [
    rows => { rows[0].id = rows[1].id },
    rows => { rows[0].incident_id = 1 },
    rows => { rows[0].sha = 'b'.repeat(40) },
    rows => { rows[0].filepath = 'other.yml' },
    rows => { rows[0].change_type = 'deletion' },
    rows => { rows[0].source.type = 'gitlab' },
    rows => { rows[0].source.full_name = 'someone/Mikka' },
    rows => { rows[0].source.full_name = 'alexj11324/mikka-copy' },
    rows => { rows[0].source.url = 'https://example.invalid' },
    rows => { rows[0].source.url = `http://github.com/${TARGET.repository}` },
    rows => { rows[0].source.url = `https://github.com.invalid/${TARGET.repository}` },
    rows => { rows[0].source.url = `https://github.com/${TARGET.repository}?other=true` },
    rows => { rows[0].source.external_id = '1' },
  ]) {
    const rows = occurrences(); mutate(rows)
    assert.throws(() => validateOccurrences(rows, headers), code('OCCURRENCE_SCOPE'))
  }
  assert.throws(() => validateOccurrences(occurrences().slice(1), headers), code('OCCURRENCE_COUNT'))
  assert.throws(() => validateOccurrences([...occurrences(), occurrences()[0]], headers), code('OCCURRENCE_COUNT'))
  assert.throws(() => validateOccurrences(occurrences(), new Headers({ link: '<https://api.gitguardian.com/v1/occurrences/secrets?page=2>; rel="next"' })), code('OCCURRENCE_COUNT'))
  const multiple = occurrences(); multiple[0].matches.push(clone(multiple[0].matches[0]))
  assert.throws(() => validateOccurrences(multiple, headers), code('MATCH_COUNT'))
  const line = occurrences(); line[0].matches[0].post_line_end++
  assert.throws(() => validateOccurrences(line, headers), code('MATCH_POSITION'))
  const duplicate = occurrences(); duplicate[0].matches[0] = clone(duplicate[1].matches[0])
  assert.throws(() => validateOccurrences(duplicate, headers), code('MATCH_COVERAGE'))
})

function fakeApi(overrides = {}) {
  const calls = [], receipt = report()
  let state = overrides.startIgnored ? 'IGNORED' : 'TRIGGERED'
  let incidentReads = 0
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search
    calls.push({ path, method: options.method })
    assert.equal(new URL(url).origin, 'https://api.gitguardian.com')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.headers['x-privacy-mode'], 'true')
    let value
    if (path === ROUTES.token) value = overrides.token ?? token()
    else if (path === ROUTES.occurrences || path === ROUTES.inspectionOccurrences) value = overrides.occurrences ?? occurrences()
    else if (path === ROUTES.incident) {
      incidentReads++
      value = overrides.incident?.(incidentReads, state) ?? incident(state)
    } else if (path === ROUTES.ignore) {
      assert.equal(options.method, 'POST')
      assert.deepEqual(JSON.parse(options.body), { ignore_reason: 'false_positive' })
      assert.ok(calls.slice(0, -1).every(call => call.method === 'GET'))
      state = 'IGNORED'
      value = incident(state)
    } else assert.fail('unexpected API route')
    return Response.json(value)
  }
  return { calls, receipt, request: guardianClient('synthetic', fetcher) }
}

test('only metadata GETs precede the single exact ignore POST, followed by verified readback', async () => {
  const api = fakeApi()
  await dispose({ request: api.request, report: api.receipt })
  assert.deepEqual(api.calls, [
    { path: ROUTES.token, method: 'GET' }, { path: ROUTES.incident, method: 'GET' },
    { path: ROUTES.occurrences, method: 'GET' }, { path: ROUTES.incident, method: 'GET' },
    { path: ROUTES.ignore, method: 'POST' }, { path: ROUTES.incident, method: 'GET' },
  ])
  assert.equal(api.receipt.result, 'verified')
  assert.equal(api.receipt.writeAttempts, 1)
  assert.deepEqual(api.receipt.occurrenceIds, [100, 101, 102])
})

test('an already ignored false positive is read back without another write', async () => {
  const api = fakeApi({ startIgnored: true })
  await dispose({ request: api.request, report: api.receipt })
  assert.equal(api.receipt.result, 'verified')
  assert.equal(api.receipt.writeAttempts, 0)
  assert.ok(api.calls.every(call => call.method === 'GET'))
})

test('bad token, extra occurrence or state drift blocks before any write', async () => {
  for (const overrides of [
    { token: { ...token(), workspace_id: 1 } },
    { occurrences: [...occurrences(), occurrences()[0]] },
    { incident: read => read === 2 ? { ...incident(), occurrences_count: 4 } : incident() },
    { incident: read => read === 2 ? { ...incident('IGNORED'), ignore_reason: 'low_risk' } : incident() },
  ]) {
    const api = fakeApi(overrides)
    await assert.rejects(dispose({ request: api.request, report: api.receipt }))
    assert.equal(api.receipt.writeAttempts, 0)
    assert.equal(api.receipt.result, 'blocked')
    assert.ok(api.calls.every(call => call.method === 'GET'))
  }
})

test('a failed final readback cannot report success or retry the mutation', async () => {
  const api = fakeApi({ incident: (read, state) => read === 3 ? incident() : incident(state) })
  await assert.rejects(dispose({ request: api.request, report: api.receipt }), code('FINAL_READBACK'))
  assert.equal(api.receipt.result, 'blocked')
  assert.equal(api.calls.filter(call => call.method === 'POST').length, 1)
})

test('client rejects plaintext, arbitrary or alternate-target routes before fetch', async () => {
  let fetched = false
  const request = guardianClient('synthetic', async () => { fetched = true; assert.fail('unexpected fetch') })
  for (const [route, method] of [
    ['/v1/occurrences/secrets/100/content', 'GET'], ['/v1/secrets/1', 'GET'],
    ['/v1/incidents/secrets/1/ignore', 'POST'], [ROUTES.incident, 'POST'],
    [ROUTES.ignore, 'DELETE'], ['https://example.invalid', 'GET'],
  ]) await assert.rejects(request(route, method), code('API_ROUTE'))
  assert.equal(fetched, false)
})

test('HTTP errors do not read provider response bodies and transport errors remain closed', async () => {
  let canceled = false
  const request = guardianClient('synthetic', async () => ({ status: 403,
    body: { cancel: async () => { canceled = true } },
    json: async () => assert.fail('must not read an error body'),
    text: async () => assert.fail('must not read an error body'),
  }))
  await assert.rejects(request(ROUTES.token), code('API_HTTP'))
  assert.equal(canceled, true)
  const unavailable = guardianClient('synthetic', async () => { throw new Error('untrusted-provider-text') })
  await assert.rejects(unavailable(ROUTES.token), code('API_TRANSPORT'))
})

test('inspection identifies field mismatches without serializing arbitrary provider strings', () => {
  const actual = inspectIncident({ ...incident(), occurrences_count: 12,
    detector: { display_name: 'generic password' },
    gitguardian_url: `https://dashboard.gitguardian.com/workspace/${TARGET.workspace}/incidents/${TARGET.incident}/` })
  assert.equal(actual.idMatches, true)
  assert.equal(actual.expectedCount, 3)
  assert.equal(actual.actualCount, 12)
  assert.equal(actual.countMatches, false)
  assert.equal(actual.detectorExactMatches, false)
  assert.equal(actual.detectorCasefoldMatches, true)
  assert.equal(actual.urlExactMatches, false)
  assert.equal(actual.urlHostMatches, true)
  assert.equal(actual.urlWorkspaceMatches, true)
  assert.equal(actual.urlIncidentMatches, true)
  assert.equal(actual.urlPathMatches, false)
  assert.equal(actual.urlPathTrailingSlashMatches, true)
  assert.equal(actual.projectionEmpty, true)
  const arbitrary = inspectIncident({ id: 'provider-string', occurrences_count: 'provider-string',
    detector: { display_name: 'provider-string' }, gitguardian_url: 'provider-string',
    status: 'provider-string', occurrences: ['provider-string'], secret_hash: 'provider-string' })
  assert.equal(arbitrary.actualCount, null)
  assert.equal(arbitrary.status, 'OTHER')
  assert.equal(arbitrary.urlParseable, false)
  assert.equal(JSON.stringify(arbitrary).includes('provider-string'), false)
  assert.ok(Object.values(arbitrary).every(value => typeof value === 'boolean' || typeof value === 'number' || value === null || value === 'OTHER'))
})

test('inspection reads only token, projected incident and bounded occurrence metadata while the disposition guard stays unchanged', async () => {
  const api = fakeApi({ incident: () => ({ ...incident(), occurrences_count: 12 }) })
  await inspect({ request: api.request, report: api.receipt })
  assert.deepEqual(api.calls, [{ path: ROUTES.token, method: 'GET' }, { path: ROUTES.incident, method: 'GET' },
    { path: ROUTES.inspectionOccurrences, method: 'GET' }])
  assert.equal(api.receipt.result, 'inspected')
  assert.equal(api.receipt.writeAttempts, 0)
  assert.equal(api.receipt.inspection.countMatches, false)
  assert.throws(() => validateIncident({ ...incident(), occurrences_count: 12 }), code('INCIDENT_SCOPE'))
})

test('occurrence inspection reports only bounded source identifiers, allowed paths and integer positions', () => {
  const rows = occurrences()
  const fourth = clone(rows[0])
  fourth.id = 103; fourth.sha = 'c'.repeat(40); fourth.filepath = 'docs/example.md'
  fourth.matches[0].pre_line_start = 2; fourth.matches[0].pre_line_end = 2
  rows.push(fourth)
  const view = inspectOccurrences(rows, new Headers())
  assert.equal(view.returnedCount, 4)
  assert.equal(view.noNextPage, true)
  assert.deepEqual(view.rows[3], { id: 103, incidentMatches: true, repoNumericMatches: true,
    repoNameMatches: true, sourceID: 10, sha: 'c'.repeat(40), filePath: 'docs/example.md', changeType: 'addition',
    matches: [{ preLineStart: 2, preLineEnd: 2, postLineStart: 13, postLineEnd: 13 }] })
  assert.throws(() => validateOccurrences(rows, new Headers()), code('OCCURRENCE_COUNT'))
  assert.throws(() => inspectOccurrences([...rows, fourth, fourth], new Headers()), code('INSPECTION_OCCURRENCE_LIMIT'))
  assert.throws(() => inspectOccurrences(rows, new Headers({ link: '<https://api.gitguardian.com/v1/occurrences/secrets?page=2>; rel="prev next"' })), code('INSPECTION_OCCURRENCE_LIMIT'))
  for (const filePath of ['/absolute', '../escape', 'dir/../escape', 'dir//file', 'unsafe\npath', 'a'.repeat(513), 'https://example.invalid']) {
    const invalid = clone(fourth); invalid.filepath = filePath
    assert.equal(inspectOccurrences([invalid], new Headers()).rows[0].filePath, null)
  }
  const outside = clone(fourth); outside.source.external_id = '1'; outside.filepath = 'outside.md'
  assert.equal(inspectOccurrences([outside], new Headers()).rows[0].filePath, null)
  const arbitrary = clone(fourth)
  arbitrary.id = 'provider-string'; arbitrary.source.full_name = 'provider-string'; arbitrary.source.id = 'provider-string'
  arbitrary.sha = 'provider-string'; arbitrary.filepath = 'provider-string\n'; arbitrary.change_type = 'provider-string'
  arbitrary.matches = [{ name: 'provider-string', match: 'provider-string', post_line_start: 'provider-string' }]
  arbitrary.secret_hash = 'provider-string'
  assert.equal(JSON.stringify(inspectOccurrences([arbitrary], new Headers())).includes('provider-string'), false)
})

test('this diagnostic revision cannot invoke disposition through the CLI', () => {
  const child = spawnSync(process.execPath, [new URL('./gitguardian-37068506.mjs', import.meta.url).pathname, '--apply'], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  })
  assert.equal(child.status, 1)
  const receipt = JSON.parse(child.stdout.trim())
  assert.equal(receipt.error, 'MODE')
  assert.equal(receipt.writeAttempts, 0)
  assert.deepEqual(receipt.requests, [])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assessIncident, disposeFalsePositives, guardWorkflow, verifySourceEvidence } from './issue1712-gitguardian-prefix-status.mjs'

// Public immutable source only. Assemble the public marker to avoid creating a
// second scanner occurrence while testing the one occurrence being assessed.
const PUBLIC_SOURCE = String.raw`import { z } from 'zod'

/** A third-party grant is opaque to every runner. Never a native model key. */
export const TASK_SECRETS_HEADER = 'x-mikka-task-secrets'
export const TASK_SECRETS_VERSION = '1'
export const TASK_SECRET_MAX_CAPABILITIES = 32
export const TASK_SECRET_MAX_TOKEN_BYTES = 65_536
export const TASK_SECRET_MAX_ASSIGNMENT_BYTES = 262_144
__PUBLIC_PREFIX_DECLARATION__
// The complete first 15 bytes have a stable base64 prefix even when the token
// follows. Pattern masking avoids keeping every 90-second bearer forever.
const ENCODED_CAPABILITY_PREFIX = 'bWlra2EtZWdyZXNzLXYx'
const CAPABILITY_PATTERNS = [
  /mikka-egress-v1\.[A-Za-z0-9_-]+/g,
  /bWlra2EtZWdyZXNzLXYx[A-Za-z0-9+/]+={0,2}/g,
]
const MAX_MASK_HOLDBACK = 4 * Math.ceil(TASK_SECRET_MAX_TOKEN_BYTES / 3)

export function maskTaskSecretCapabilities(value: string, replacement = '[secret:TASK_SECRET_CAPABILITY]'): string {
  let output = value
  for (const pattern of CAPABILITY_PATTERNS) output = output.replace(pattern, replacement)
  return output
}

/** Keep at most one bounded token-shaped suffix while output is streaming. */
export function taskSecretCapabilityHoldback(value: string): number {
  let startOfTail = value.length
  while (startOfTail > 0 && /[A-Za-z0-9_.+/=-]/.test(value[startOfTail - 1])) startOfTail--
  const tail = value.slice(startOfTail)
  if (!tail) return 0
  let hold = 0
  for (const prefix of [TASK_SECRET_CAPABILITY_PREFIX, ENCODED_CAPABILITY_PREFIX]) {
    const start = tail.indexOf(prefix)
    if (start >= 0) hold = Math.max(hold, Math.min(tail.length - start, MAX_MASK_HOLDBACK))
    for (let length = Math.min(prefix.length - 1, tail.length); length > hold; length--) {
      if (prefix.startsWith(tail.slice(-length))) { hold = length; break }
    }
  }
  return hold
}

const secretName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
export const taskSecretGrantSchema = z.object({
  name: secretName,
  capability: z.string().min(1).max(TASK_SECRET_MAX_TOKEN_BYTES),
  expiresAt: z.iso.datetime(),
  origin: z.url().max(512),
}).strict()
export type TaskSecretGrant = z.infer<typeof taskSecretGrantSchema>

/** Metadata is safe to describe; the opaque bearer itself must not be logged. */
export const taskSecretAccessSchema = z.object({
  version: z.literal(1),
  endpoint: z.url().max(2_000),
  grants: z.array(taskSecretGrantSchema).max(TASK_SECRET_MAX_CAPABILITIES),
  unavailable: z.array(secretName).max(1500),
}).strict().refine(value => JSON.stringify(value).length <= TASK_SECRET_MAX_ASSIGNMENT_BYTES, 'task Secret assignment too large')
export type TaskSecretAccess = z.infer<typeof taskSecretAccessSchema>

/** Existing heartbeats carry the current opaque leases; no extra request loop. */
export const taskSecretRenewalSchema = z.array(z.string().min(1).max(TASK_SECRET_MAX_TOKEN_BYTES))
  .max(TASK_SECRET_MAX_CAPABILITIES)
  .refine(value => value.reduce((size, token) => size + token.length, 0) <= TASK_SECRET_MAX_ASSIGNMENT_BYTES, 'task Secret renewal too large')
`.replace('__PUBLIC_PREFIX_DECLARATION__', ['export const', ['TASK', 'SECRET', 'CAPABILITY', 'PREFIX'].join('_'),
  '=', "'" + ['mikka', 'egress', 'v1.'].join('-') + "'"].join(' '))
const REVISION = 'df8a36f7db9cc72508b1ccea86514ac5c4c224cf'
const SOURCE_URL = 'https://raw.githubusercontent.com/alexj11324/Mikka/' + REVISION + '/packages/protocol/src/task-secrets.ts'
const API = 'https://api.gitguardian.com/v1', INCIDENT = 39804367, OCCURRENCE = 311114581, WORKSPACE = 837165
const BRANCH = 'refs/heads/ops/issue1712-gitguardian-prefix-status'
const TOKEN = 'synthetic-token-in-test-only'
function response(value, url, { status = 200, headers = {} } = {}) {
  const result = new Response(typeof value === 'string' ? value : JSON.stringify(value), { status, headers })
  Object.defineProperty(result, 'url', { value: url }); return result
}
const evidence = () => verifySourceEvidence(async (url, options) => {
  assert.equal(url, SOURCE_URL); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit')
  assert.equal(options.headers.authorization, undefined)
  return response(PUBLIC_SOURCE, url)
})
function fixture(status = 'TRIGGERED') {
  return { detail: { id: INCIDENT, status, ...(status === 'IGNORED' ? { ignore_reason: 'false_positive' } : {}),
    occurrences_count: 1, gitguardian_url: 'https://dashboard.gitguardian.com/workspace/' + WORKSPACE + '/incidents/' + INCIDENT,
    unusedSecretField: 'RAW_DO_NOT_EXPORT' },
  occurrences: [{ id: OCCURRENCE, incident_id: INCIDENT, sha: REVISION, filepath: 'packages/protocol/src/task-secrets.ts',
    change_type: 'addition', source: { type: 'github', full_name: 'alexj11324/Mikka', url: 'https://github.com/alexj11324/Mikka', external_id: 1427517699 },
    matches: [{ post_line_start: 9, post_line_end: 9 }], unusedContent: 'RAW_DO_NOT_EXPORT' }] }
}
async function report() {
  return { sourceEvidence: await evidence(), requests: [], incidents: [], writeAttempts: 0,
    writeResponsesAccepted: 0, allBindingsVerifiedBeforeWrite: false }
}
function apiFixture(data, report, { workspaceId = WORKSPACE, paginated = false, ambiguousWrite = false, afterFailed = false } = {}) {
  const calls = []
  const fetcher = async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit')
    assert.equal(options.headers.authorization, 'Token ' + TOKEN)
    calls.push({ url, method: options.method })
    const post = options.method === 'POST'
    if (post) {
      assert.equal(url, API + '/incidents/secrets/' + INCIDENT + '/ignore')
      assert.equal(options.body, '{"ignore_reason":"false_positive"}')
      assert.equal(report.allBindingsVerifiedBeforeWrite, true)
      assert.equal(report.writeAttempts, 1)
      if (ambiguousWrite) throw Error('RAW_NETWORK_DIAGNOSTIC')
      return response({ ignored: true }, url)
    }
    assert.equal(options.method, 'GET')
    if (url === API + '/api_tokens/self') return response({ status: 'active', scopes: ['incidents:write'], workspace_id: workspaceId }, url)
    if (url === API + '/occurrences/secrets?incident_id=' + INCIDENT + '&per_page=100') return response(data.occurrences, url,
      { headers: paginated ? { link: '<https://untrusted.invalid/next>; rel="next"' } : {} })
    assert.equal(url, API + '/incidents/secrets/' + INCIDENT)
    const after = calls.filter(call => call.url === url).length > 1
    return response(after && !afterFailed ? { ...data.detail, status: 'IGNORED', ignore_reason: 'false_positive' } : data.detail, url)
  }
  return { calls, fetcher }
}

test('the immutable complete public source and exact line are proved without any token or content API', async () => {
  const proof = await evidence()
  assert.equal(proof.revision, REVISION)
  assert.equal(proof.evidenceSha256, '08afff55d72f47b158e71dfbfa6ddef88fdda6948d46cd46556ea5e8af20268a')
  assert.equal(proof.evidenceLineSha256, 'b9907a76d56fa4e3a8e43c0c3b044e2351f7a13bdb530a77e3cd54f0b5e6d697')
  assert.equal(proof.evidenceLine, 9); assert.equal(proof.prefixBytes, 16); assert.equal(proof.publicPrefixVerified, true)
  assert.ok(!JSON.stringify(proof).includes(['mikka', 'egress', 'v1.'].join('-')))
  await assert.rejects(verifySourceEvidence(async url => response(PUBLIC_SOURCE + '\n', url)), /GG_SOURCE_DIGEST/)
  await assert.rejects(verifySourceEvidence(async url => response(PUBLIC_SOURCE, url + '?foreign')), /GG_SOURCE_HTTP/)
  await assert.rejects(verifySourceEvidence(async url => response('', url, { status: 302 })), /GG_SOURCE_HTTP/)
  await assert.rejects(verifySourceEvidence(async url => response(PUBLIC_SOURCE, url, { headers: { 'content-length': '3000000' } })), /GG_RESPONSE_SIZE/)
})

test('incident assessment refuses any extra occurrence, foreign scope, source, commit, path, line or disposition state', () => {
  const good = fixture()
  assert.equal(assessIncident(good.detail, good.occurrences, INCIDENT, WORKSPACE).occurrenceId, OCCURRENCE)
  for (const mutate of [value => { value.detail.id++ }, value => { value.detail.status = 'RESOLVED' },
    value => { value.detail.status = 'IGNORED'; value.detail.ignore_reason = 'test' },
    value => { value.detail.gitguardian_url = value.detail.gitguardian_url.replace('/837165/', '/1/') },
    value => { value.detail.occurrences_count = 2 }, value => { value.occurrences.push(value.occurrences[0]) },
    value => { value.occurrences[0].id++ }, value => { value.occurrences[0].incident_id++ },
    value => { value.occurrences[0].source.type = 'gitlab' }, value => { value.occurrences[0].source.full_name = 'foreign/Mikka' },
    value => { value.occurrences[0].source.url = 'https://github.com/alexj11324/foreign' },
    value => { value.occurrences[0].source.external_id++ }, value => { value.occurrences[0].sha = 'a'.repeat(40) },
    value => { value.occurrences[0].filepath = 'packages/protocol/src/foreign.ts' },
    value => { value.occurrences[0].change_type = 'deletion' }, value => { value.occurrences[0].matches = [] },
    value => { value.occurrences[0].matches[0].post_line_start = 10 }, value => { value.occurrences[0].matches[0].post_line_end = 10 }]) {
    const changed = fixture(); mutate(changed)
    assert.throws(() => assessIncident(changed.detail, changed.occurrences, INCIDENT, WORKSPACE))
  }
  assert.throws(() => assessIncident(good.detail, good.occurrences, INCIDENT + 1, WORKSPACE))
  assert.throws(() => assessIncident(good.detail, good.occurrences, INCIDENT, WORKSPACE + 1))
})

test('only the one exact false_positive POST occurs after all bindings, followed by metadata readback', async () => {
  const result = await report(), api = apiFixture(fixture(), result)
  await disposeFalsePositives({ token: TOKEN, report: result, fetcher: api.fetcher })
  assert.deepEqual(api.calls.map(call => call.method), ['GET', 'GET', 'GET', 'POST', 'GET'])
  assert.equal(result.writeAttempts, 1); assert.equal(result.writeResponsesAccepted, 1)
  assert.equal(result.incidents[0].afterStatus, 'IGNORED')
  assert.equal(result.incidents[0].ignoreReason, 'false_positive')
  assert.doesNotMatch(JSON.stringify(result), /RAW_DO_NOT_EXPORT|synthetic-token|Bearer|Token /)
  assert.ok(api.calls.every(call => !/\/content(?:\/|$)|\/secret$|check-runs|config|skip/.test(call.url)))
})

test('missing source proof, wrong workspace, incomplete pages and changed occurrence stop before any write', async () => {
  for (const mutate of [value => { delete value.sourceEvidence }, value => { value.sourceEvidence.evidenceSha256 = 'f'.repeat(64) },
    value => { value.sourceEvidence.evidenceLine = 10 }, value => { value.sourceEvidence.publicPrefixVerified = false }]) {
    const result = await report(); mutate(result)
    let calls = 0
    await assert.rejects(disposeFalsePositives({ token: TOKEN, report: result, fetcher: async () => { calls++; assert.fail('must not request') } }), /GG_SOURCE_REQUIRED/)
    assert.equal(calls, 0)
  }
  for (const options of [{ workspaceId: WORKSPACE + 1 }, { paginated: true }, { foreign: true }]) {
    const result = await report(), data = fixture()
    if (options.foreign) data.occurrences[0].sha = 'f'.repeat(40)
    const api = apiFixture(data, result, options)
    await assert.rejects(disposeFalsePositives({ token: TOKEN, report: result, fetcher: api.fetcher }))
    assert.equal(result.writeAttempts, 0); assert.ok(api.calls.every(call => call.method === 'GET'))
  }
})

test('an already confirmed false positive is idempotent; ambiguous writes are never retried or reported as success', async () => {
  const done = await report(), existing = apiFixture(fixture('IGNORED'), done)
  await disposeFalsePositives({ token: TOKEN, report: done, fetcher: existing.fetcher })
  assert.equal(done.writeAttempts, 0); assert.ok(existing.calls.every(call => call.method === 'GET'))
  for (const options of [{ ambiguousWrite: true }, { afterFailed: true }]) {
    const result = await report(), api = apiFixture(fixture(), result, options)
    await assert.rejects(disposeFalsePositives({ token: TOKEN, report: result, fetcher: api.fetcher }))
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(result.incidents[0].afterStatus, undefined)
    assert.doesNotMatch(JSON.stringify(result), /RAW_NETWORK|synthetic-token/)
  }
})

test('workflow guard permits only this repository ops push and binds the event identity before source or API work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gg1712-event-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'event.json'), sha = 'a'.repeat(40)
  const original = { ref: BRANCH, after: sha, deleted: false,
    repository: { full_name: 'alexj11324/Mikka', id: 1427517699, owner: { id: 183887963 }, fork: false } }
  const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'alexj11324/Mikka',
    GITHUB_REF: BRANCH, GITHUB_SHA: sha, GITHUB_EVENT_PATH: path }
  await writeFile(path, JSON.stringify(original)); await guardWorkflow(env)
  for (const patch of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REPOSITORY: 'fork/Mikka' }, { GITHUB_SHA: 'main' }]) {
    await assert.rejects(guardWorkflow({ ...env, ...patch }))
  }
  for (const mutate of [value => { value.after = 'b'.repeat(40) }, value => { value.deleted = true },
    value => { value.repository.id++ }, value => { value.repository.owner.id++ }, value => { value.repository.fork = true }]) {
    const changed = structuredClone(original); mutate(changed); await writeFile(path, JSON.stringify(changed))
    await assert.rejects(guardWorkflow(env))
  }
})

test('workflow checks the public evidence before the existing single-token OIDC read and grants no scanner/check write permissions', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/issue1712-gitguardian-prefix-status.yml', import.meta.url), 'utf8')
  assert.match(workflow, /branches: \[ops\/issue1712-gitguardian-prefix-status\]/)
  assert.ok(workflow.indexOf('mjs --check') < workflow.indexOf('Infisical/secrets-action'))
  assert.match(workflow, /identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/)
  assert.match(workflow, /project-id: 89850d6a-f020-4936-863e-df77380dfe40/)
  assert.match(workflow, /secret-path: \/vercel/)
  assert.match(workflow, /secret-name: GITGUARDIAN_API_TOKEN/)
  assert.match(workflow, /recursive: false/); assert.match(workflow, /include-imports: false/)
  assert.equal(workflow.match(/Infisical\/secrets-action/g)?.length, 1)
  assert.doesNotMatch(workflow, /contents: write|checks: write|statuses: write|actions: write|pull_request_target|workflow_dispatch/)
})


import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_KEYS, captureRuntimeSnapshot, safeFailure, summarizeTuple, writeSnapshotReceipt } from './runtime-snapshot.mjs'

const SENTINEL = 'PRIVATE_VALUE_NEVER_IN_A_RECEIPT'
const SOURCE = 'a'.repeat(40), WORKER = 'b'.repeat(40)
const PREVIOUS = 'MIKKA_CLOUD_RUNTIME_PREVIOUS'
const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: 'refs/heads/ops/issue-1503-runtime-snapshot', GITHUB_EVENT_NAME: 'push',
  VERCEL_TEAM_TOKEN: SENTINEL }
function tuple(source = SOURCE, legacy = false) {
  const models = harness => [{ harness, installed: true, version: null, models: [harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5'],
    modelSlots: [{ slot: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', model: harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', name: SENTINEL }] }]
  const catalogue = { version: 1, workerSha: WORKER, ...(!legacy ? { sourceCommit: source } : {}),
    templates: Object.fromEntries(['desktop', 'claude', 'codex'].map(kind => [kind, {
      templateId: legacy ? kind : 'tpl-' + kind,
      ...(!legacy ? { baseTemplate: kind, preinstalled: true } : {}),
      models: kind === 'desktop' ? [...models('claude_code'), ...models('codex')] : models(kind === 'claude' ? 'claude_code' : 'codex'),
    }])) }
  return { E2B_BYO_COMPUTER_TEMPLATE: legacy ? 'desktop' : 'tpl-desktop', E2B_CLAUDE_TEMPLATE: legacy ? 'claude' : 'tpl-claude',
    E2B_CODEX_TEMPLATE: legacy ? 'codex' : 'tpl-codex', MIKKA_CLOUD_WORKER_SHA: WORKER,
    MIKKA_CLOUD_TEMPLATE_MODELS: JSON.stringify(catalogue), MIKKA_CLOUD_WORKER_SOURCE_COMMIT: source }
}
function fixture({ previous = true, mutateMetadata = () => {}, mutateValue = () => {} } = {}) {
  const configuration = tuple()
  const entries = { ...configuration, ...(previous ? { [PREVIOUS]: JSON.stringify({ version: 1, configuration: tuple('d'.repeat(40), true) }) } : {}) }
  const metadata = Object.entries(entries).map(([key, value], i) => ({ key, value, id: 'env-' + i,
    target: ['production'], type: 'plain', updatedAt: 1000 }))
  const noise = Array.from({ length: 358 }, (_, i) => ({ key: 'UNRELATED_' + i, value: SENTINEL, id: 'private-' + i,
    target: ['production'], type: 'sensitive' }))
  const calls = []; let lists = 0
  const fetchImpl = async (url, options) => {
    url = new URL(url)
    assert.equal(url.origin, 'https://api.vercel.com')
    assert.equal(url.searchParams.get('teamId'), 'team_C7lwxVVvnUicFli6112mvxpv')
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined)
    assert.equal(options.headers.authorization, 'Bearer ' + SENTINEL)
    assert.equal(options.redirect, 'error')
    calls.push(url.pathname)
    if (url.pathname === '/v10/projects/prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH/env') {
      assert.equal(url.searchParams.get('decrypt'), 'false')
      const value = { envs: [...structuredClone(noise), ...structuredClone(metadata)] }
      mutateMetadata(value, ++lists)
      return Response.json(value)
    }
    const row = metadata.find(row => url.pathname === '/v1/projects/prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH/env/' + row.id)
    assert.ok(row, 'only the seven fixed runtime keys can be decrypted')
    const value = structuredClone(row); mutateValue(value)
    return Response.json(value)
  }
  return { env, fetchImpl, calls, configuration, entries }
}

test('reads the complete inventory but only the exact seven values, with content-free comparable tuple hashes', async () => {
  const f = fixture()
  const receipt = await captureRuntimeSnapshot(f)
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.readonly, true)
  assert.equal(receipt.stage, 'complete')
  assert.equal(receipt.metadataFenceMatched, true); assert.equal(f.calls.length, 9)
  assert.equal(receipt.selectedKeyCount, 7)
  assert.equal(receipt.current.sourceCommit, SOURCE); assert.equal(receipt.current.workerSha, WORKER)
  assert.equal(receipt.previous.present, true); assert.equal(receipt.previous.catalogue.sourceCommitPresent, false)
  assert.equal(receipt.current.tupleHash, createHash('sha256').update(JSON.stringify([
    ['E2B_BYO_COMPUTER_TEMPLATE', 'tpl-desktop'], ['E2B_CLAUDE_TEMPLATE', 'tpl-claude'], ['E2B_CODEX_TEMPLATE', 'tpl-codex'],
    ['MIKKA_CLOUD_WORKER_SHA', WORKER], ['MIKKA_CLOUD_TEMPLATE_MODELS', f.configuration.MIKKA_CLOUD_TEMPLATE_MODELS],
    ['MIKKA_CLOUD_WORKER_SOURCE_COMMIT', SOURCE],
  ])).digest('hex'))
  const reversed = Object.fromEntries(Object.entries(f.configuration).reverse())
  assert.equal(summarizeTuple(reversed).tupleHash, receipt.current.tupleHash)
  assert.equal(receipt.current.catalogueSha256, createHash('sha256').update(f.configuration.MIKKA_CLOUD_TEMPLATE_MODELS).digest('hex'))
  assert.equal(JSON.stringify(receipt).includes(SENTINEL), false)
  assert.equal(JSON.stringify(receipt).includes('UNRELATED_'), false)
  assert.ok(receipt.current.catalogue.templates.every(row => row.reports.every(report => report.smallModelPresent)))
})

test('a publication preserves exactly the before current tuple hash in after previous', async () => {
  const before = await captureRuntimeSnapshot(fixture())
  const f = fixture({ mutateValue: row => {
    if (row.key === PREVIOUS) row.value = JSON.stringify({ version: 1, configuration: tuple() })
  } })
  const after = await captureRuntimeSnapshot(f)
  assert.equal(after.previous.tupleHash, before.current.tupleHash)
})

test('a missing previous is explicit and does not invent a rollback tuple', async () => {
  const f = fixture({ previous: false }), result = await captureRuntimeSnapshot(f)
  assert.deepEqual(result.previous, { present: false }); assert.equal(f.calls.length, 8)
})

test('missing, duplicate, truncated and paginated inventories fail before any value read', async () => {
  for (const mutate of [v => { v.envs = v.envs.filter(row => row.key !== CURRENT_KEYS[0]) },
    v => { v.envs.push(structuredClone(v.envs.find(row => row.key === CURRENT_KEYS[0]))) },
    v => { v.truncated = true }, v => { v.pagination = { next: 123 } }]) {
    const f = fixture({ mutateMetadata: mutate })
    await assert.rejects(captureRuntimeSnapshot(f), error => ['key_missing_or_duplicated', 'metadata_incomplete'].includes(error.code))
    assert.equal(f.calls.length, 1)
  }
})

test('a changed selected metadata value or revision fails the bounded consistency fence', async () => {
  for (const field of ['value', 'updatedAt']) {
    const f = fixture({ mutateMetadata: (response, number) => {
      if (number === 2) response.envs.find(row => row.key === CURRENT_KEYS[0])[field] = field === 'value' ? 'changed' : 1001
    } })
    await assert.rejects(captureRuntimeSnapshot(f), { code: 'configuration_changed' })
    assert.equal(f.calls.length, 9)
  }
})

test('unrelated response fields, invalid pairings and extra previous keys never enter a successful receipt', async () => {
  for (const mutate of [row => { if (row.key === CURRENT_KEYS[0]) row.key = 'FOREIGN' },
    row => { if (row.key === 'MIKKA_CLOUD_WORKER_SHA') row.value = 'e'.repeat(40) },
    row => { if (row.key === PREVIOUS) row.value = JSON.stringify({ version: 1, configuration: { ...tuple(), FOREIGN: SENTINEL } }) },
    row => { if (row.key === 'MIKKA_CLOUD_TEMPLATE_MODELS') { const parsed = JSON.parse(row.value); parsed.unexpected = SENTINEL; row.value = JSON.stringify(parsed) } }]) {
    const f = fixture({ mutateValue: mutate })
    await assert.rejects(captureRuntimeSnapshot(f), error => {
      assert.equal(JSON.stringify(safeFailure(error)).includes(SENTINEL), false)
      return ['value_invalid', 'configuration_invalid', 'catalogue_invalid'].includes(error.code)
    })
  }
})

test('a foreign workflow identity is refused before requests and an expected runtime source is enforced', async () => {
  const f = fixture()
  await assert.rejects(captureRuntimeSnapshot({ ...f, env: { ...env, GITHUB_REF: 'refs/heads/main' } }), { code: 'identity_invalid' })
  assert.equal(f.calls.length, 0)
  await assert.rejects(captureRuntimeSnapshot({ ...f, env: { ...env, MIKKA_EXPECTED_RUNTIME_SOURCE: 'f'.repeat(40) } }), { code: 'source_mismatch' })
})

test('transport and provider errors produce only a closed failure with actual workflow identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-snapshot-'))
  try {
    const output = join(directory, 'receipt.json')
    const result = await writeSnapshotReceipt({ output, env, fetchImpl: async () => { throw Error(SENTINEL) } })
    assert.equal(result.status, 'failed'); assert.equal(result.code, 'api_failed')
    assert.equal(result.identity.sourceCommit, env.GITHUB_SHA); assert.equal(result.identity.runId, '123')
    assert.equal(result.readonly, true)
    assert.equal(result.stage, 'metadata_before')
    assert.deepEqual(result.requests, [{ method: 'GET', endpoint: '/v10/projects/{project}/env?decrypt=false' }])
    assert.ok(Number.isFinite(Date.parse(result.startedAt)))
    const raw = await readFile(output, 'utf8')
    assert.equal(raw.includes(SENTINEL), false); assert.equal(raw.includes('cause'), false)
    assert.equal(Object.hasOwn(result, 'current'), false)
    const f = fixture({ mutateValue: row => { if (row.key === CURRENT_KEYS[0]) row.key = 'FOREIGN' } })
    const valueFailure = await writeSnapshotReceipt({ ...f, output })
    assert.equal(valueFailure.stage, 'values'); assert.equal(valueFailure.requests.length, 8)
    assert.equal(valueFailure.identity.runId, '123')
    const invalid = await writeSnapshotReceipt({ output, env: { ...env, GITHUB_REF: SENTINEL } })
    assert.equal(invalid.stage, 'identity'); assert.equal(invalid.identity, null)
    assert.deepEqual(invalid.requests, [])
    assert.equal((await readFile(output, 'utf8')).includes(SENTINEL), false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

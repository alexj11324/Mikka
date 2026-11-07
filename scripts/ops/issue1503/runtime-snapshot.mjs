#!/usr/bin/env node
/** One read-only, content-free snapshot of the fixed project's runtime pair. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { api, PROJECT, TEAM, runtimeConfigurationSha } from '../../e2b/publish-template-env.mjs'

export const CURRENT_KEYS = Object.freeze(['E2B_BYO_COMPUTER_TEMPLATE', 'E2B_CLAUDE_TEMPLATE', 'E2B_CODEX_TEMPLATE',
  'MIKKA_CLOUD_WORKER_SHA', 'MIKKA_CLOUD_TEMPLATE_MODELS', 'MIKKA_CLOUD_WORKER_SOURCE_COMMIT'])
const PREVIOUS = 'MIKKA_CLOUD_RUNTIME_PREVIOUS'
const KEYS = [...CURRENT_KEYS, PREVIOUS]
const SHA = /^[a-f0-9]{40}$/
const ID = /^[A-Za-z0-9_-]{1,100}$/
const KINDS = ['desktop', 'claude', 'codex']
const HARNESSES = { desktop: ['claude_code', 'codex'], claude: ['claude_code'], codex: ['codex'] }
const MODELS = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' }
const CODES = new Set(['identity_invalid', 'credential_missing', 'api_failed', 'metadata_invalid', 'metadata_incomplete',
  'key_missing_or_duplicated', 'value_invalid', 'configuration_invalid', 'catalogue_invalid', 'previous_invalid',
  'configuration_changed', 'source_mismatch', 'unexpected'])
const hash = text => createHash('sha256').update(text).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const check = (ok, code) => { if (!ok) throw new SnapshotError(code) }
const keysExactly = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const keysWithin = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key))
const boundedText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value

export class SnapshotError extends Error {
  constructor(code, cause) {
    const closed = CODES.has(code) ? code : 'unexpected'
    super(`runtime_snapshot_${closed}`, cause === undefined ? undefined : { cause })
    this.code = closed
  }
}
export const safeFailure = error => ({ status: 'failed', code: error instanceof SnapshotError ? error.code : 'unexpected' })

function catalogueSummary(value, configuration) {
  // Both the preinstalled and legacy official CLI probes return only
  // harness/installed/version + ModelReport (models/modelSlots/defaultModelSlot).
  // This is the probe's persisted format, not the broader device HarnessInfo DTO.
  check(keysWithin(value, ['version', 'workerSha', 'sourceCommit', 'templates'])
    && value.version === 1 && keysExactly(value.templates, KINDS), 'catalogue_invalid')
  const templates = KINDS.map((kind, index) => {
    const row = value.templates[kind]
    check(keysWithin(row, ['templateId', 'baseTemplate', 'preinstalled', 'models'])
      && row.templateId === configuration[CURRENT_KEYS[index]] && Array.isArray(row.models)
      && row.models.length > 0 && row.models.length <= 2, 'catalogue_invalid')
    const reports = row.models.map(report => {
      check(keysWithin(report, ['harness', 'installed', 'version', 'models', 'modelSlots', 'defaultModelSlot'])
        && Object.hasOwn(MODELS, report.harness) && typeof report.installed === 'boolean'
        && (report.version === undefined || report.version === null || boundedText(report.version, 200)), 'catalogue_invalid')
      const models = report.models ?? [], slots = report.modelSlots ?? []
      check(Array.isArray(models) && models.length <= 500 && models.every(model => boundedText(model, 128))
        && Array.isArray(slots) && slots.length <= 500
        && slots.every(slot => keysExactly(slot, ['slot', 'model', 'name']) && boundedText(slot.slot, 128)
          && boundedText(slot.model, 128) && boundedText(slot.name, 200))
        && (report.defaultModelSlot === undefined || boundedText(report.defaultModelSlot, 128)), 'catalogue_invalid')
      return { harness: report.harness, installed: report.installed, modelCount: models.length, slotCount: slots.length,
        smallModelPresent: models.includes(MODELS[report.harness]) || slots.some(slot => slot.model === MODELS[report.harness]) }
    })
    check(new Set(reports.map(row => row.harness)).size === reports.length
      && HARNESSES[kind].every(harness => reports.some(row => row.harness === harness && row.installed)), 'catalogue_invalid')
    return { kind, templateId: row.templateId, baseTemplate: row.baseTemplate ?? null,
      preinstalled: row.preinstalled ?? null, reports }
  })
  return { version: 1, sourceCommitPresent: Object.hasOwn(value, 'sourceCommit'), templates }
}

export function summarizeTuple(configuration) {
  check(keysExactly(configuration, CURRENT_KEYS)
    && CURRENT_KEYS.every(key => typeof configuration[key] === 'string' && configuration[key].length <= 262144)
    && CURRENT_KEYS.slice(0, 3).every(key => ID.test(configuration[key]))
    && SHA.test(configuration.MIKKA_CLOUD_WORKER_SHA) && SHA.test(configuration.MIKKA_CLOUD_WORKER_SOURCE_COMMIT), 'configuration_invalid')
  let catalogue
  try { catalogue = JSON.parse(configuration.MIKKA_CLOUD_TEMPLATE_MODELS) }
  catch (cause) { throw new SnapshotError('catalogue_invalid', cause) }
  check(runtimeConfigurationSha(configuration, { allowLegacy: true }) === configuration.MIKKA_CLOUD_WORKER_SHA, 'configuration_invalid')
  return { tupleHash: hash(JSON.stringify(CURRENT_KEYS.map(key => [key, configuration[key]]))),
    workerSha: configuration.MIKKA_CLOUD_WORKER_SHA, sourceCommit: configuration.MIKKA_CLOUD_WORKER_SOURCE_COMMIT,
    templates: Object.fromEntries(KINDS.map((kind, index) => [kind, configuration[CURRENT_KEYS[index]]])),
    catalogueSha256: hash(configuration.MIKKA_CLOUD_TEMPLATE_MODELS),
    catalogue: catalogueSummary(catalogue, configuration) }
}

function selectMetadata(response) {
  check(object(response) && Array.isArray(response.envs) && response.envs.length <= 10000, 'metadata_invalid')
  check(response.truncated !== true && !response.pagination?.next, 'metadata_incomplete')
  return KEYS.map(key => {
    const rows = response.envs.filter(row => row?.key === key && Array.isArray(row.target)
      && row.target.includes('production') && !row.gitBranch)
    check(rows.length === 1 || key === PREVIOUS && rows.length === 0, 'key_missing_or_duplicated')
    if (!rows.length) return { key, absent: true }
    const row = rows[0]
    check(ID.test(row.id ?? '') && ['plain', 'encrypted', 'secret', 'sensitive', 'system'].includes(row.type)
      && row.target.every(target => ['production', 'preview', 'development'].includes(target))
      && (row.updatedAt === undefined || Number.isSafeInteger(row.updatedAt))
      && (row.createdAt === undefined || Number.isSafeInteger(row.createdAt))
      && typeof row.value === 'string', 'metadata_invalid')
    // Even legacy rows without timestamps have a stable encrypted/plain value
    // fingerprint. Only the seven selected rows are accessed beyond metadata.
    return { key, id: row.id, type: row.type, target: [...row.target].sort(),
      updatedAt: row.updatedAt ?? null, createdAt: row.createdAt ?? null, metadataValueHash: hash(row.value) }
  })
}

function snapshotIdentity(env) {
  check(env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && SHA.test(env.GITHUB_SHA ?? '')
    && /^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]{0,4}$/.test(env.GITHUB_RUN_ATTEMPT ?? '')
    && env.GITHUB_REF === 'refs/heads/ops/issue-1503-runtime-snapshot'
    && ['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'identity_invalid')
  return { repository: env.GITHUB_REPOSITORY, sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, ref: env.GITHUB_REF }
}

function snapshotProgress() {
  return { identity: null, startedAt: new Date().toISOString(), stage: 'identity', requests: [] }
}

async function captureSnapshot({ env = process.env, fetchImpl = fetch, now = () => new Date().toISOString() }, progress) {
  const startedAt = now()
  progress.startedAt = startedAt
  const identity = snapshotIdentity(env)
  progress.identity = identity
  check(!env.MIKKA_EXPECTED_RUNTIME_SOURCE || SHA.test(env.MIKKA_EXPECTED_RUNTIME_SOURCE), 'identity_invalid')
  progress.stage = 'credential'
  check(typeof env.VERCEL_TEAM_TOKEN === 'string' && env.VERCEL_TEAM_TOKEN.length > 0, 'credential_missing')
  const requests = progress.requests
  const read = async (path, endpoint) => {
    requests.push({ method: 'GET', endpoint })
    try { return await api(path, { method: 'GET', token: env.VERCEL_TEAM_TOKEN, fetchImpl }) }
    catch (cause) { throw new SnapshotError('api_failed', cause) }
  }
  const list = () => read(`/v10/projects/${PROJECT}/env?decrypt=false`, '/v10/projects/{project}/env?decrypt=false')
  progress.stage = 'metadata_before'
  const before = selectMetadata(await list())
  progress.stage = 'values'
  const values = await Promise.all(before.filter(row => !row.absent).map(async row => {
    const value = await read(`/v1/projects/${PROJECT}/env/${row.id}`, '/v1/projects/{project}/env/{selected-id}')
    check(object(value) && value.key === row.key && (value.id === undefined || value.id === row.id)
      && value.type === row.type && typeof value.value === 'string' && value.value.length <= 524288, 'value_invalid')
    return [row.key, value.value]
  }))
  progress.stage = 'metadata_after'
  const after = selectMetadata(await list())
  check(isDeepStrictEqual(before, after), 'configuration_changed')
  progress.stage = 'current_validation'
  const entries = Object.fromEntries(values)
  const current = summarizeTuple(Object.fromEntries(CURRENT_KEYS.map(key => [key, entries[key]])))
  check(!env.MIKKA_EXPECTED_RUNTIME_SOURCE || current.sourceCommit === env.MIKKA_EXPECTED_RUNTIME_SOURCE, 'source_mismatch')
  progress.stage = 'previous_validation'
  let previous = { present: false }
  if (Object.hasOwn(entries, PREVIOUS)) {
    let parsed
    try { parsed = JSON.parse(entries[PREVIOUS]) } catch (cause) { throw new SnapshotError('previous_invalid', cause) }
    check(keysExactly(parsed, ['version', 'configuration']) && parsed.version === 1, 'previous_invalid')
    previous = { present: true, ...summarizeTuple(parsed.configuration) }
  }
  progress.stage = 'complete'
  return { version: 1, status: 'passed', readonly: true,
    identity, stage: progress.stage,
    startedAt, finishedAt: now(), apiOrigin: 'https://api.vercel.com', projectId: PROJECT, teamId: TEAM,
    tupleEncoding: 'sha256(UTF8(JSON.stringify(ordered [key, rawValue] pairs)))', tupleKeyOrder: CURRENT_KEYS,
    metadataFenceMatched: true, selectedKeyCount: values.length, requests, current, previous }
}

export async function captureRuntimeSnapshot(options = {}) {
  return captureSnapshot(options, snapshotProgress())
}

export async function writeSnapshotReceipt({ output = 'issue1503-report/runtime-snapshot.json', ...options } = {}) {
  const progress = snapshotProgress()
  let receipt
  try { receipt = await captureSnapshot(options, progress) }
  catch (error) { receipt = { version: 1, readonly: true, identity: progress.identity,
    startedAt: progress.startedAt, finishedAt: new Date().toISOString(), stage: progress.stage,
    requests: progress.requests, apiOrigin: 'https://api.vercel.com', projectId: PROJECT, teamId: TEAM, ...safeFailure(error) } }
  await mkdir(dirname(resolve(output)), { recursive: true })
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await writeSnapshotReceipt()
    console.log(JSON.stringify({ status: result.status, ...(result.code ? { code: result.code } : {}),
      ...(result.current ? { currentTupleHash: result.current.tupleHash, previousTupleHash: result.previous.tupleHash ?? null } : {}) }))
    if (result.status !== 'passed') process.exitCode = 1
  } catch {
    console.error(JSON.stringify({ status: 'failed', code: 'receipt_write_failed' }))
    process.exitCode = 1
  }
}

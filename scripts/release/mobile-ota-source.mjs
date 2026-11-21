import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { downloadReleaseReport } from '../acceptance/task-secrets-ci.mjs'
import { actionsMikkaRepository, officialMikkaRepository, publicRepositoryId } from '../cloudflare-source.mjs'

export const OTA_SOURCE_ARTIFACT = 'mobile-production-ota-source'
const workflow = '.github/workflows/mobile-update.yml'
const sha = /^[a-f0-9]{40}$/, number = /^[1-9][0-9]{0,15}$/
const keys = value => Object.keys(value).sort()
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

/** Tree identities include accumulated changes even if a later Web merge superseded a mobile push. */
export function mobileInputs(root, overlay, sourceCommit, overlayCommit) {
  for (const [path, expected] of [[root, sourceCommit], [overlay, overlayCommit]]) {
    assert.match(expected ?? '', sha)
    assert.equal(git(path, 'rev-parse', 'HEAD'), expected)
    assert.equal(git(path, 'status', '--porcelain', '--untracked-files=no'), '')
  }
  const inputs = { mobile: git(root, 'rev-parse', 'HEAD:apps/mobile'), protocol: git(root, 'rev-parse', 'HEAD:packages/protocol'),
    overlayMobile: git(overlay, 'rev-parse', 'HEAD:mobile') }
  for (const value of Object.values(inputs)) assert.match(value, sha)
  return { sourceCommit, overlayCommit, inputs }
}

export function sourceReceipt(value) {
  assert.deepEqual(keys(value), ['inputs', 'kind', 'overlayCommit', 'runAttempt', 'runId', 'sourceCommit', 'version'])
  assert.equal(value.version, 1)
  assert.equal(value.kind, 'mobile-ota-source')
  for (const key of ['sourceCommit', 'overlayCommit']) assert.match(value[key], sha)
  for (const key of ['runId', 'runAttempt']) assert.match(value[key], number)
  assert.deepEqual(keys(value.inputs), ['mobile', 'overlayMobile', 'protocol'])
  for (const tree of Object.values(value.inputs)) assert.match(tree, sha)
  return value
}

function trustedRun(run, { originalAttempt = true } = {}) {
  for (const field of ['repository', 'head_repository']) {
    assert.ok(officialMikkaRepository(run[field]?.full_name, String(run[field]?.id)))
    assert.equal(run[field].fork, false)
    assert.equal(run[field].private, false)
  }
  assert.equal(run.path, workflow)
  assert.equal(run.head_branch, 'main')
  assert.ok(['push', 'workflow_dispatch', 'workflow_run'].includes(run.event))
  assert.equal(run.actor?.id, 183887963)
  if (originalAttempt) assert.equal(run.triggering_actor?.id, 183887963)
  assert.match(run.head_sha, sha)
}

/** The source archive alone never claims publication. The original publish step must have completed. */
export function checkedMobilePublication(run, jobs, artifact, receipt) {
  sourceReceipt(receipt); trustedRun(run)
  assert.equal(String(run.id), receipt.runId)
  assert.equal(String(run.run_attempt), receipt.runAttempt)
  assert.equal(run.head_sha, receipt.sourceCommit)
  assert.equal(run.status, 'completed')
  const selected = jobs.filter(job => job.name === 'EAS Update')
  assert.equal(selected.length, 1)
  const [job] = selected
  assert.equal(String(job.run_id), receipt.runId)
  assert.equal(String(job.run_attempt), receipt.runAttempt)
  assert.equal(job.head_sha, receipt.sourceCommit)
  assert.equal(job.status, 'completed')
  const step = name => {
    const matches = job.steps.filter(value => value.name === name)
    assert.equal(matches.length, 1)
    return matches[0]
  }
  const upload = step('Preserve the immutable mobile source receipt')
  assert.equal(upload.conclusion, 'success')
  const publish = step('Publish to production')
  if (publish.conclusion !== 'success') return { status: 'unconfirmed' }
  assert.equal(step('Compare actual mobile release inputs').conclusion, 'success')
  assert.equal(step('Recheck the owner window immediately before publication').conclusion, 'success')
  assert.ok(upload.number < publish.number)
  const created = Date.parse(artifact.created_at), started = Date.parse(publish.started_at), completed = Date.parse(publish.completed_at)
  assert.ok(Number.isFinite(created) && Number.isFinite(started) && Number.isFinite(completed) && created <= started && started <= completed)
  // A later cleanup failure does not undo a completed Expo publication. Never
  // substitute the workflow's overall success for this exact step's result.
  return { status: 'published', receipt, publishedAt: publish.completed_at }
}

async function pages(json, path, key) {
  const items = [], seen = new Set()
  for (let page = 1;; page++) {
    const result = await json(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    assert.ok(Number.isSafeInteger(result.total_count) && result.total_count >= 0 && Array.isArray(result[key]))
    for (const item of result[key]) {
      assert.ok(Number.isSafeInteger(item.id) && item.id > 0 && !seen.has(item.id))
      seen.add(item.id); items.push(item)
    }
    if (items.length >= result.total_count) { assert.equal(items.length, result.total_count); return items }
    assert.ok(result[key].length, 'Incomplete mobile publication history')
  }
}

/** Only the newest trusted source receipt is considered; an unconfirmed or expired one blocks automatic OTA. */
export async function latestMobilePublication({ json, download, now = Date.now(), repository = 'alexj11324/Mikka' }) {
  assert.ok(officialMikkaRepository(repository, publicRepositoryId))
  const api = `https://api.github.com/repos/${repository}`
  const artifacts = await pages(json, `actions/artifacts?name=${OTA_SOURCE_ARTIFACT}`, 'artifacts')
  const trusted = []
  for (const artifact of artifacts) {
    assert.equal(artifact.name, OTA_SOURCE_ARTIFACT)
    if (artifact.workflow_run?.repository_id !== 1427517699 || artifact.workflow_run.head_repository_id !== 1427517699
      || artifact.workflow_run.head_branch !== 'main') continue
    assert.ok(Number.isSafeInteger(artifact.workflow_run.id) && artifact.workflow_run.id > 0)
    const run = await json('actions/runs/' + artifact.workflow_run.id)
    if (run.path !== workflow) continue
    trustedRun(run, { originalAttempt: false })
    assert.equal(artifact.workflow_run.head_sha, run.head_sha)
    assert.ok(Number.isFinite(Date.parse(artifact.created_at)))
    trusted.push(artifact)
  }
  trusted.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id)
  if (!trusted.length) return { status: 'missing' }
  const [artifact] = trusted
  if (artifact.expired || Date.parse(artifact.expires_at) <= now) return { status: 'expired' }
  assert.equal(artifact.expired, false)
  assert.ok(Number.isFinite(Date.parse(artifact.expires_at)) && Date.parse(artifact.created_at) <= now + 60_000)
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 32 * 1024)
  assert.match(artifact.digest ?? '', /^sha256:[a-f0-9]{64}$/)
  assert.equal(artifact.url, `${api}/actions/artifacts/${artifact.id}`)
  assert.equal(artifact.archive_download_url, artifact.url + '/zip')
  const bytes = await download({ selected: true, artifact: { id: artifact.id, sha256: artifact.digest.slice(7), sizeBytes: artifact.size_in_bytes } })
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 8 * 1024)
  const receipt = sourceReceipt(JSON.parse(bytes))
  assert.equal(receipt.runId, String(artifact.workflow_run.id))
  assert.equal(receipt.sourceCommit, artifact.workflow_run.head_sha)
  const attempt = `actions/runs/${receipt.runId}/attempts/${receipt.runAttempt}`
  return checkedMobilePublication(await json(attempt), await pages(json, attempt + '/jobs', 'jobs'), artifact, receipt)
}

export function selectMobilePublication(candidate, baseline, event) {
  if (baseline.status === 'published') {
    const changed = keys(candidate.inputs).some(key => candidate.inputs[key] !== baseline.receipt.inputs[key])
    return { selected: changed, reason: changed ? 'mobile_inputs_changed' : 'mobile_inputs_unchanged' }
  }
  assert.ok(['missing', 'expired', 'unconfirmed'].includes(baseline.status))
  return event === 'workflow_dispatch'
    ? { selected: true, reason: 'owner_bootstrap_' + baseline.status }
    : { selected: false, reason: 'mobile_baseline_' + baseline.status }
}

function candidate(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true')
  const repository = actionsMikkaRepository(env)
  assert.ok(repository)
  assert.equal(env.GITHUB_ACTOR_ID, '183887963')
  assert.equal(env.GITHUB_REF, 'refs/heads/main')
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${workflow}@refs/heads/main`)
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA)
  assert.ok(['push', 'workflow_run', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME))
  const root = resolve(env.GITHUB_WORKSPACE)
  return sourceReceipt({ version: 1, kind: 'mobile-ota-source', runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    ...mobileInputs(root, resolve(root, '.hosted-ui'), env.GITHUB_SHA, env.OVERLAY_SHA) })
}

async function main(command, env) {
  const current = candidate(env), directory = resolve(env.RUNNER_TEMP, 'mobile-ota-source'), file = resolve(directory, 'release.json')
  const repository = env.GITHUB_REPOSITORY, api = `https://api.github.com/repos/${repository}`
  if (command === 'verify') {
    assert.deepEqual(sourceReceipt(JSON.parse(await readFile(file, 'utf8'))), current)
    return
  }
  assert.equal(command, 'select')
  assert.ok(env.GH_TOKEN)
  const json = async path => {
    const response = await fetch(api + '/' + path, { headers: { accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + env.GH_TOKEN, 'x-github-api-version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(20_000) })
    assert.equal(response.status, 200, 'Mobile publication metadata unavailable')
    return response.json()
  }
  const run = await json(`actions/runs/${current.runId}/attempts/${current.runAttempt}`)
  trustedRun(run)
  assert.equal(String(run.id), current.runId)
  assert.equal(String(run.run_attempt), current.runAttempt)
  assert.equal(run.head_sha, current.sourceCommit)
  const baseline = await latestMobilePublication({ json, repository, download: proof => downloadReleaseReport(proof, { token: env.GH_TOKEN, repository }) })
  const selection = selectMobilePublication(current, baseline, env.GITHUB_EVENT_NAME)
  if (selection.selected) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify(current) + '\n', { mode: 0o600, flag: 'wx' })
  }
  await appendFile(env.GITHUB_OUTPUT, `selected=${selection.selected}\nreason=${selection.reason}\n`)
  console.log('MIKKA_MOBILE_SOURCE_SELECTION=' + JSON.stringify(selection))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv[2], process.env).catch(() => { console.error('MOBILE_OTA_SOURCE_EVIDENCE_INVALID'); process.exitCode = 1 })
}

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

export const PIN = Object.freeze({
  repository: 'alexj11324/Mikka', owner: 'alexj11324',
  branch: 'ops/1782-private-duplicate-cleanup-20261109',
  workflow: '.github/workflows/1782-private-duplicate-cleanup.yml',
  parent: '7170b31386825aaceba248a2bc4edc9ed408fcbf',
  targetRun: 42645207132, targetAttempt: 1, targetWorkflow: 410913883,
  targetBranch: 'ops/self-hosted-vault-closeout-20261108',
  targetPath: '.github/workflows/self-hosted-vault-closeout.yml',
  targetHead: '7170b31386825aaceba248a2bc4edc9ed408fcbf',
  source: '98a47306abf3f098e9186da5d0c969dc8dc01335',
  worker: '7bc7ec86ec6a9e932cd2074420f0d7ff40aadbfd',
  protectedRuns: [42642763434, 42643948671],
  files: {
    '.github/workflows/self-hosted-vault-closeout.yml': {
      blob: '1091674fbe28516b81ae7c8b58dc19427eaf035c', bytes: 6686,
      sha256: 'f9d4a2306a7caef0289a10de62f108b3e44e3908be5806af0a025b372a5eb4cf',
    },
    'scripts/ops/workspace-private-acceptance.mjs': {
      blob: '1ab268b37f965359628adba575800f46a837ddae', bytes: 49804,
      sha256: '284e168e6b28470c484560f3caceb406c1d6ac89ebc06626d99ed4fb0ec13cef',
    },
  },
})
const codes = new Set(['context', 'self_run', 'parent', 'target', 'target_state', 'source', 'jobs',
  'token', 'api', 'body_limit', 'json', 'cancel_unconfirmed', 'unexpected'])
const check = (value, code) => { if (!value) throw new Error(code) }
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const runId = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))

export function assertContext(env, event, checkout, dirty) {
  check(env.GITHUB_REPOSITORY === PIN.repository && env.GITHUB_REPOSITORY_OWNER === PIN.owner
    && env.GITHUB_ACTOR === PIN.owner && env.GITHUB_TRIGGERING_ACTOR === PIN.owner
    && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === `refs/heads/${PIN.branch}`
    && env.GITHUB_WORKFLOW_REF === `${PIN.repository}/${PIN.workflow}@refs/heads/${PIN.branch}`
    && sha(env.GITHUB_SHA) && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA && checkout === env.GITHUB_SHA
    && env.GITHUB_RUN_ATTEMPT === '1' && runId(env.GITHUB_RUN_ID) && !dirty
    && event.ref === env.GITHUB_REF && event.after === env.GITHUB_SHA && event.deleted === false
    && event.forced === false && event.repository?.full_name === PIN.repository
    && event.repository?.owner?.login === PIN.owner && event.sender?.login === PIN.owner, 'context')
  check(![PIN.targetRun, ...PIN.protectedRuns].includes(Number(env.GITHUB_RUN_ID)), 'context')
}

export function assertTarget(run, pending = true) {
  check(run.id === PIN.targetRun && !PIN.protectedRuns.includes(run.id)
    && run.run_attempt === PIN.targetAttempt && run.workflow_id === PIN.targetWorkflow
    && run.head_sha === PIN.targetHead && run.head_branch === PIN.targetBranch && run.path === PIN.targetPath
    && run.event === 'push' && run.actor?.login === PIN.owner && run.triggering_actor?.login === PIN.owner
    && run.repository?.full_name === PIN.repository && run.head_repository?.full_name === PIN.repository, 'target')
  if (pending) check(['pending', 'queued'].includes(run.status) && run.conclusion === null, 'target_state')
}

export function assertNoJobs(value) {
  check(value.total_count === 0 && Array.isArray(value.jobs) && value.jobs.length === 0, 'jobs')
}

export function assertSourceFile(path, file) {
  const pin = PIN.files[path]
  check(pin && file.type === 'file' && file.path === path && file.encoding === 'base64'
    && file.sha === pin.blob && file.size === pin.bytes && typeof file.content === 'string', 'source')
  const bytes = Buffer.from(file.content, 'base64')
  check(bytes.length === pin.bytes && createHash('sha256').update(bytes).digest('hex') === pin.sha256, 'source')
  return bytes.toString('utf8')
}

async function main(env = process.env) {
  const receipt = { version: 1, operation: 'cancel_one_pending_duplicate',
    controllerRun: runId(env.GITHUB_RUN_ID) ? Number(env.GITHUB_RUN_ID) : null,
    controllerSource: sha(env.GITHUB_SHA) ? env.GITHUB_SHA : null,
    targetRun: PIN.targetRun, targetHead: PIN.targetHead, targetAttempt: PIN.targetAttempt,
    productSource: PIN.source, workerSha: PIN.worker, protectedRuns: PIN.protectedRuns,
    sourcePinsVerified: false, pendingObserved: false, jobsObserved: null,
    cancelRequested: false, cancelHttpStatus: null, cancellationConfirmed: false,
    resourceAbsenceClaimed: false, outcome: 'refused', error: null }
  let success = false
  try {
    check(process.argv.length === 2, 'context')
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'))
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16_384 }).trim()
    assertContext(env, event, git('rev-parse', 'HEAD'), git('status', '--porcelain', '--untracked-files=all') !== '')
    check(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0, 'token')
    let postUsed = false
    const api = async (path, method = 'GET') => {
      check(method === 'GET' || method === 'POST' && path === `/actions/runs/${PIN.targetRun}/cancel` && !postUsed, 'api')
      if (method === 'POST') { postUsed = true; receipt.cancelRequested = true }
      const response = await fetch(`https://api.github.com/repos/${PIN.repository}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28' },
      })
      if (method === 'POST') receipt.cancelHttpStatus = response.status
      check(response.status === (method === 'POST' ? 202 : 200), 'api')
      if (method === 'POST') { await response.body?.cancel(); return null }
      const chunks = []; let length = 0
      for await (const chunk of response.body ?? []) {
        length += chunk.length; check(length <= 262_144, 'body_limit'); chunks.push(chunk)
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('json') }
    }
    const self = await api(`/actions/runs/${env.GITHUB_RUN_ID}`)
    check(self.id === Number(env.GITHUB_RUN_ID) && self.run_attempt === 1 && self.event === 'push'
      && self.path === PIN.workflow && self.head_sha === env.GITHUB_SHA && self.head_branch === PIN.branch
      && self.repository?.full_name === PIN.repository && self.head_repository?.full_name === PIN.repository
      && self.actor?.login === PIN.owner && self.triggering_actor?.login === PIN.owner
      && self.status === 'in_progress' && self.conclusion === null, 'self_run')
    const commit = await api(`/git/commits/${env.GITHUB_SHA}`)
    check(commit.sha === env.GITHUB_SHA && commit.parents?.length === 1 && commit.parents[0].sha === PIN.parent, 'parent')
    assertTarget(await api(`/actions/runs/${PIN.targetRun}`))
    assertNoJobs(await api(`/actions/runs/${PIN.targetRun}/jobs?filter=all&per_page=1`))
    const files = {}
    for (const path of Object.keys(PIN.files)) {
      files[path] = assertSourceFile(path, await api(`/contents/${path}?ref=${PIN.targetHead}`))
    }
    const collector = files['scripts/ops/workspace-private-acceptance.mjs'].split('export const P0 = Object.freeze({\n')[1]?.split('\n})')[0]
    check(collector?.includes(`source: '${PIN.source}'`) && collector.includes(`workerSha: '${PIN.worker}'`)
      && files[PIN.targetPath].includes(`P0_SOURCE: ${PIN.source}`)
      && files[PIN.targetPath].includes(`ref: ${PIN.source}`), 'source')
    receipt.sourcePinsVerified = true
    // Repeat the read-only guards immediately before the sole POST. GitHub does
    // not offer atomic cancel-if-queued: the receipt never claims zero resources.
    assertTarget(await api(`/actions/runs/${PIN.targetRun}`))
    assertNoJobs(await api(`/actions/runs/${PIN.targetRun}/jobs?filter=all&per_page=1`))
    receipt.pendingObserved = true; receipt.jobsObserved = 0
    await api(`/actions/runs/${PIN.targetRun}/cancel`, 'POST')
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await delay(1_000)
      const target = await api(`/actions/runs/${PIN.targetRun}`)
      assertTarget(target, false)
      assertNoJobs(await api(`/actions/runs/${PIN.targetRun}/jobs?filter=all&per_page=1`))
      if (target.status === 'completed' && target.conclusion === 'cancelled') {
        receipt.cancellationConfirmed = true; break
      }
    }
    check(receipt.cancellationConfirmed, 'cancel_unconfirmed')
    receipt.outcome = 'pending_duplicate_cancelled'; success = true
  } catch (error) {
    receipt.error = codes.has(error?.message) ? error.message : 'unexpected'
    if (receipt.cancelRequested) receipt.outcome = 'cancel_requested_unconfirmed'
  }
  const directory = resolve(env.RUNNER_TEMP, '1782-private-duplicate-cleanup')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(receipt))
  if (!success) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('duplicate_cleanup_receipt_unavailable'); process.exitCode = 1 })
}

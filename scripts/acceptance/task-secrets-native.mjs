// Runs once inside the ordinary task VM, through its actual native shell tool.
// The fixture's key/canary never reach this process. Git/gh use only the normal
// selected task credential; stdout contains a closed receipt, never subprocess
// output, authentication, headers, capabilities, or file contents.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, readdir, lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { startTaskSecretBridge, TASK_SECRET_DUMMY_KEY } from '../../packages/daemon/src/task-secret-bridge.ts'

export const REPOSITORY = 'alexj11324/Mikka-handoff'
export const RECEIPT = 'MIKKA_1712_NATIVE '
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Error(code) }
const round = value => Math.round(value * 1000) / 1000
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]

export function nativeScope(value) {
  check(value && UUID.test(value.caseId ?? '') && ['claude_code', 'codex'].includes(value.harness)
    && SHA.test(value.sourceCommit ?? '') && SHA.test(value.workerSha ?? '')
    && SHA.test(value.workerSourceCommit ?? ''), 'configuration')
  check(value.repository === REPOSITORY, 'repository_scope')
  const fixture = new URL(value.fixtureOrigin), upstream = new URL(value.upstreamOrigin)
  check([fixture, upstream].every(url => url.protocol === 'https:' && url.origin === url.href.slice(0, -1)
    && !url.username && !url.password && /^[a-zA-Z0-9.-]+\.(?:e2b\.app|e2b\.dev)$/.test(url.hostname)), 'fixture_scope')
  const production = value.deliveryMode === 'production_claim'
  check(DIGEST.test(value.canarySha256 ?? '') && DIGEST.test(value.responseSha256 ?? ''), 'configuration')
  if (production) check(/^ACCEPTANCE_1712_[A-F0-9]{32}$/.test(value.secretName ?? '')
    && ['revocation', 'fresh_claim'].includes(value.phase) && DIGEST.test(value.sdkResponseSha256 ?? '')
    && value.bootstrapToken === undefined
    && (value.previousCanarySha256 === undefined || DIGEST.test(value.previousCanarySha256)), 'configuration')
  else check(value.deliveryMode === undefined && DIGEST.test(value.bootstrapToken ?? ''), 'configuration')
  return { ...value, branch: `acceptance/1712/${value.caseId}/${value.harness}`,
    filename: `acceptance-1712-${value.caseId}.txt` }
}

/** Detect only the disposable canary. No unrelated environment/file value is
 * ever returned. The explicit finite scope is included in the evidence. */
export async function scanCanary(canarySha256, { environment = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  check(DIGEST.test(canarySha256), 'configuration')
  let matches = 0, files = 0, bytes = 0, unavailable = 0, truncated = false
  const inspect = value => {
    for (const item of value.matchAll(/mikka1712s_[a-f0-9]{64}/g)) if (hash(item[0]) === canarySha256) matches++
  }
  for (const value of Object.values(environment)) if (typeof value === 'string') inspect(value)
  const queue = [resolve(home, '.mikka'), resolve(home, '.claude'), resolve(home, '.codex'), resolve(cwd)]
  const seen = new Set()
  while (queue.length) {
    if (files >= 1000 || bytes >= 32 * 1024 * 1024) { truncated = true; break }
    const path = queue.pop()
    if (seen.has(path)) continue
    seen.add(path)
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        const children = await readdir(path, { withFileTypes: true })
        for (const child of children) if (!['.git', 'node_modules', '.cache'].includes(child.name)) queue.push(join(path, child.name))
      } else if (info.isFile() && info.size <= 1024 * 1024) {
        const value = await readFile(path); files++; bytes += value.length; inspect(value.toString('utf8'))
      }
    } catch { unavailable++ }
  }
  for (const path of ['/proc/self/environ', '/proc/self/cmdline', `/proc/${process.ppid}/environ`, `/proc/${process.ppid}/cmdline`]) {
    try { const value = await readFile(path); inspect(value.toString('utf8')); files++; bytes += value.length } catch { unavailable++ }
  }
  return { matched: matches > 0, files, bytes, unavailable, truncated,
    scope: 'own_environment_parent_process_runtime_homes_worktree_bounded_scan' }
}

async function httpProof(config, runId, fetchImpl) {
  const input = { runId, bootstrapToken: config.bootstrapToken }
  const call = async (url, options = {}) => fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(25_000) })
  const granted = await call(`${config.fixtureOrigin}/grant/${config.caseId}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  check(granted.ok, 'grant_refused')
  const { expiredCapability, ...access } = await granted.json()
  check(access.version === 1 && access.grants?.length === 1 && access.grants[0].name === 'SYNTHETIC_PROTECTED'
    && access.endpoint === `${config.fixtureOrigin}/egress/${runId}` && typeof expiredCapability === 'string', 'grant_invalid')
  const abort = new AbortController()
  const bridge = await startTaskSecretBridge({ current: () => access, signal: abort.signal, fetch: fetchImpl })
  check(bridge, 'bridge_missing')
  try {
    const base = JSON.parse(bridge.env.MIKKA_SECRET_ENDPOINTS).SYNTHETIC_PROTECTED
    const timings = { direct: [], protected: [] }
    for (let index = 0; index < 10; index++) for (const mode of ['direct', 'protected']) {
      const start = performance.now()
      const response = await call(mode === 'direct' ? `${config.upstreamOrigin}/v1/public/${config.caseId}` : `${base}/v1/protected/${config.caseId}`,
        mode === 'protected' ? { headers: { authorization: `Bearer ${TASK_SECRET_DUMMY_KEY}` } } : {})
      const bytes = Buffer.from(await response.arrayBuffer())
      check(response.status === 200 && hash(bytes) === config.responseSha256, 'upstream_response')
      timings[mode].push(round(performance.now() - start))
    }
    const denied = async (path, options = {}) => {
      const response = await call(`${base}${path}`, options)
      const text = await response.text()
      check(response.status >= 400 && ![...text.matchAll(/mikka1712s_[a-f0-9]{64}/g)].some(match => hash(match[0]) === config.canarySha256), 'request_not_blocked')
      return response.status
    }
    const refused = {
      method: await denied(`/v1/protected/${config.caseId}`, { method: 'POST' }),
      path: await denied(`/v1/forbidden/${config.caseId}`),
      echo: await denied(`/v1/echo/${config.caseId}`),
      redirect: await denied(`/v1/redirect/${config.caseId}`),
      origin: await denied(`/v1/protected/${config.caseId}`, { headers: { origin: 'https://example.invalid' } }),
      authOverride: await denied(`/v1/protected/${config.caseId}`, { headers: { authorization: 'Bearer unexpected' } }),
    }
    const envelope = capability => ({ method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability, method: 'GET', path: `/v1/protected/${config.caseId}`, headers: [] }) })
    const expired = await call(access.endpoint, envelope(expiredCapability))
    refused.expired = expired.status; await expired.body?.cancel(); check(expired.status === 410, 'expiry_not_blocked')
    const foreign = await call(`${config.fixtureOrigin}/egress/${randomUUID()}`, envelope(access.grants[0].capability))
    refused.crossRun = foreign.status; await foreign.body?.cancel(); check(foreign.status === 403, 'scope_not_blocked')
    const rotated = await call(`${config.fixtureOrigin}/rotate/${config.caseId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    check(rotated.ok, 'rotation_refused'); await rotated.body?.cancel()
    const old = await call(access.endpoint, envelope(access.grants[0].capability))
    refused.rotatedKey = old.status; await old.body?.cancel(); check(old.status === 401, 'rotation_not_blocked')
    return { scope: 'isolated_key_and_canary_real_egress_and_bridge_code', client: 'node_fetch_base_url_dummy_key',
      statuses: refused, samples: 10,
      direct: { p50Ms: percentile(timings.direct, 0.5), p95Ms: percentile(timings.direct, 0.95) },
      protected: { p50Ms: percentile(timings.protected, 0.5), p95Ms: percentile(timings.protected, 0.95) },
      baseline: 'same_fixture_public_unauthenticated_https_route',
      productionClaimTested: false, productionStoreRotationTested: false }
  } finally { abort.abort(); bridge.close() }
}

/** Use only the bridge inherited from the actual production claim. This path
 * never starts a replacement bridge, asks the fixture to mint a grant, or
 * receives the synthetic value/capability in its configuration. */
export async function productionHttpProof(config, { environment = process.env, fetchImpl = fetch } = {}) {
  check(config.deliveryMode === 'production_claim' && !Object.hasOwn(environment, config.secretName), 'secret_environment_visible')
  const endpoints = JSON.parse(environment.MIKKA_SECRET_ENDPOINTS ?? 'null')
  check(endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints), 'production_claim_missing')
  const base = endpoints[config.secretName], parsed = new URL(base)
  check(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && /^[0-9]{1,5}$/.test(parsed.port)
    && Number(parsed.port) > 0 && Number(parsed.port) <= 65535 && !parsed.username && !parsed.password
    && !parsed.search && !parsed.hash && parsed.pathname === `/${parsed.pathname.split('/')[1]}/${config.secretName}`
    && /^[a-f0-9]{48}$/.test(parsed.pathname.split('/')[1]), 'production_claim_invalid')
  const call = async (url, options = {}) => fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(25_000) })
  const samples = config.phase === 'revocation' ? 1 : 10
  const timings = { direct: [], protected: [] }
  for (let index = 0; index < samples; index++) for (const mode of ['direct', 'protected']) {
    const start = performance.now()
    const response = await call(mode === 'direct' ? `${config.upstreamOrigin}/v1/public/${config.caseId}` : `${base}/v1/protected/${config.caseId}`,
      mode === 'protected' ? { headers: { authorization: `Bearer ${TASK_SECRET_DUMMY_KEY}` } } : {})
    const bytes = Buffer.from(await response.arrayBuffer())
    check(response.status === 200 && hash(bytes) === config.responseSha256, 'production_upstream_response')
    timings[mode].push(round(performance.now() - start))
  }
  const result = { scope: 'production_store_actual_claim_inherited_bridge', client: 'ordinary_installed_sdk_and_node_fetch',
    samples, productionClaimTested: true, productionStoreRotationTested: config.phase === 'fresh_claim',
    direct: { p50Ms: percentile(timings.direct, 0.5), p95Ms: percentile(timings.direct, 0.95) },
    protected: { p50Ms: percentile(timings.protected, 0.5), p95Ms: percentile(timings.protected, 0.95) } }
  if (config.phase === 'revocation') return result
  const denied = async (path, options = {}) => {
    const response = await call(`${base}${path}`, options), text = await response.text()
    check(response.status >= 400 && response.status <= 599
      && ![...text.matchAll(/mikka1712s_[a-f0-9]{64}/g)].some(match =>
        [config.canarySha256, config.previousCanarySha256].includes(hash(match[0]))), 'production_request_not_blocked')
    return response.status
  }
  result.statuses = {
    method: await denied(`/v1/protected/${config.caseId}`, { method: 'POST' }),
    path: await denied(`/v1/forbidden/${config.caseId}`),
    echo: await denied(`/v1/echo/${config.caseId}`),
    redirect: await denied(`/v1/redirect/${config.caseId}`),
    origin: await denied(`/v1/protected/${config.caseId}`, { headers: { origin: 'https://example.invalid' } }),
    authOverride: await denied(`/v1/protected/${config.caseId}`, { headers: { authorization: 'Bearer unexpected' } }),
  }
  const [{ createOpenAICompatible }, { generateText }] = await Promise.all([import('@ai-sdk/openai-compatible'), import('ai')])
  const provider = createOpenAICompatible({ name: 'production-protected-synthetic-fixture',
    baseURL: `${base}/sdk/${config.caseId}/v1`, apiKey: TASK_SECRET_DUMMY_KEY })
  // The installed SDK owns its normal transport. No custom fetch or headers,
  // no provider prompt/billing, and no retry: the upstream is our JSON fixture.
  const sdk = await generateText({ model: provider.chatModel('synthetic-third-party-model'),
    prompt: 'Exercise production Secret delivery against the synthetic fixture.', maxRetries: 0,
    abortSignal: AbortSignal.timeout(25_000) })
  check(hash(sdk.text) === config.sdkResponseSha256 && sdk.finishReason === 'stop'
    && sdk.usage.inputTokens === 2 && sdk.usage.outputTokens === 3, 'production_sdk_response')
  result.sdk = { ordinaryTransport: true, customFetch: false, retries: 0, responseSha256: hash(sdk.text),
    finishReason: sdk.finishReason, inputTokens: sdk.usage.inputTokens, outputTokens: sdk.usage.outputTokens }
  return result
}

/** Every destructive cleanup target is established by this invocation and
 * re-read before deletion. No force push, main write, merge, or credential API. */
export async function nativeGitProof(config, { execute = promisify(execFile) } = {}) {
  const { branch, filename } = nativeScope(config)
  const remote = `https://github.com/${REPOSITORY}.git`, directory = await mkdtemp(join(tmpdir(), 'mikka-1712-git-'))
  const worktree = join(directory, 'repository'), times = {}, receipt = { cleanup: false, branch, filename }
  let commit, base, initialBase, pushAttempted = false, createAttempted = false, prNumber, accountId
  // Reserve time for close/delete even if native network commands stall. The
  // outer launcher has its own 300-second hard deadline.
  let deadline = performance.now() + 130_000
  const run = async (command, args, cwd = directory) => {
    const remaining = Math.floor(deadline - performance.now())
    check(remaining > 0, 'native_deadline')
    try { return (await execute(command, args, { cwd, encoding: 'utf8', timeout: Math.min(45_000, remaining), maxBuffer: 1024 * 1024 })).stdout.trim() }
    catch (cause) { throw Error('native_command_failed', { cause }) }
  }
  const gh = async args => JSON.parse(await run('gh', ['api', ...args]))
  const remoteHead = async name => (await run('git', ['ls-remote', remote, `refs/heads/${name}`])).split(/\s/)[0]
  const timed = async (name, callback) => { const start = performance.now(); try { return await callback() } finally { times[name] = round(performance.now() - start) } }
  const prScope = pr => pr?.head?.ref === branch && pr.head.sha === commit && pr.head.repo?.full_name === REPOSITORY
    && pr.base?.repo?.full_name === REPOSITORY && pr.base.ref === base && pr.title === `测试 #1712 ${config.caseId}`
  const ownPr = pr => Number.isSafeInteger(accountId) && prScope(pr) && pr.user?.id === accountId && pr.number === prNumber
  try {
    const repository = await gh([`repos/${REPOSITORY}`])
    check(repository.full_name === REPOSITORY && repository.permissions?.push === true, 'github_authority')
    base = repository.default_branch
    check(typeof base === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(base) && !base.includes('..') && base !== branch, 'default_branch')
    initialBase = await remoteHead(base); check(SHA.test(initialBase), 'base_missing')
    check(await remoteHead(branch) === '', 'branch_exists')
    await timed('cloneMs', () => run('git', ['clone', '--no-tags', '--depth', '1', '--single-branch', '--branch', base, remote, worktree]))
    await timed('fetchMs', () => run('git', ['fetch', '--no-tags', 'origin', `refs/heads/${base}`], worktree))
    await run('git', ['switch', '-c', branch], worktree)
    const content = `Mikka #1712 native credential acceptance\ncase=${config.caseId}\nharness=${config.harness}\nsource=${config.sourceCommit}\n`
    await writeFile(join(worktree, filename), content, { flag: 'wx', mode: 0o600 })
    await run('git', ['add', '--', filename], worktree)
    await run('git', ['-c', 'user.name=Mikka acceptance', '-c', 'user.email=mikka-acceptance@example.invalid', 'commit', '-m', `test: disposable #1712 ${config.caseId}`], worktree)
    commit = await run('git', ['rev-parse', 'HEAD'], worktree); check(SHA.test(commit), 'commit_invalid')
    check(await run('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], worktree) === filename, 'file_scope')
    pushAttempted = true
    await timed('pushMs', () => run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], worktree))
    check(await remoteHead(branch) === commit, 'push_unconfirmed')
    const bodyPath = join(directory, 'pr-body.md')
    await writeFile(bodyPath, `Disposable native GitHub acceptance for Mikka #1712.\nCase ${config.caseId}; one fixture file.\nThis draft must be closed without merging and its branch deleted by this same test.\n`, { flag: 'wx', mode: 0o600 })
    const createStartedAt = Date.now()
    createAttempted = true
    const url = await timed('draftPrMs', () => run('gh', ['pr', 'create', '--draft', '--repo', REPOSITORY, '--base', base, '--head', branch,
      '--title', `测试 #1712 ${config.caseId}`, '--body-file', bodyPath], worktree))
    const number = /^https:\/\/github\.com\/alexj11324\/Mikka-handoff\/pull\/([1-9][0-9]*)$/.exec(url)?.[1]
    check(number && Number.isSafeInteger(Number(number)), 'pr_url'); prNumber = Number(number)
    const pr = await gh([`repos/${REPOSITORY}/pulls/${prNumber}`])
    // Installation credentials need not support /user. Establish actor
    // evidence from this exact successful creation response, never a lookup
    // after an ambiguous write. The unique head and time window are required.
    const createdAt = Date.parse(pr.created_at)
    check(prScope(pr) && pr.number === prNumber && pr.draft === true && pr.state === 'open' && !pr.merged && !pr.merged_at
      && Number.isSafeInteger(pr.user?.id) && pr.user.id > 0 && Number.isFinite(createdAt)
      && createdAt >= createStartedAt - 60_000 && createdAt <= Date.now() + 60_000, 'pr_scope')
    accountId = pr.user.id
    const file = await gh([`repos/${REPOSITORY}/contents/${filename}?ref=${commit}`])
    check(file.type === 'file' && file.path === filename && file.encoding === 'base64'
      && hash(Buffer.from(file.content, 'base64')) === hash(content), 'remote_file')
    Object.assign(receipt, { commit, defaultBranchBefore: initialBase, draftPrNumber: prNumber,
      fileSha256: hash(content), fileBytes: Buffer.byteLength(content), githubActorHash: hash(String(accountId)).slice(0, 16), times })
  } finally {
    deadline = performance.now() + 60_000
    try {
      if (pushAttempted) {
        // If a create response was lost, no actor was established. Keep the
        // remote evidence for explicit recovery instead of claiming ownership.
        check(!createAttempted || Number.isSafeInteger(accountId), 'cleanup_actor_unconfirmed')
        const pulls = await gh([`repos/${REPOSITORY}/pulls?state=all&head=alexj11324:${branch}`])
        check(Array.isArray(pulls) && pulls.length <= 1 && (!createAttempted || pulls.length === 1), 'cleanup_pr_ambiguous')
        for (const pr of pulls) {
          check(ownPr(pr) && pr.draft === true && !pr.merged_at, 'cleanup_pr_scope')
          if (pr.state === 'open') await run('gh', ['pr', 'close', String(prNumber), '--repo', REPOSITORY], worktree)
          const closed = await gh([`repos/${REPOSITORY}/pulls/${prNumber}`])
          check(ownPr(closed) && closed.state === 'closed' && !closed.merged, 'cleanup_pr_unconfirmed')
        }
        const head = await remoteHead(branch)
        check(head === '' || head === commit, 'cleanup_branch_changed')
        if (head) await run('git', ['push', 'origin', `:refs/heads/${branch}`], worktree)
        check(await remoteHead(branch) === '', 'cleanup_branch_unconfirmed')
        receipt.defaultBranchAfter = await remoteHead(base)
        check(receipt.defaultBranchAfter === initialBase, 'default_branch_changed')
        receipt.cleanup = true
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
  check(receipt.cleanup && prNumber, 'cleanup_missing')
  return receipt
}

export async function runNativeProbe(value, { fetchImpl = fetch, environment = process.env, execute } = {}) {
  const config = nativeScope(value), runId = environment.MIKKA_RUN_ID
  check(UUID.test(runId ?? ''), 'run_scope')
  const receipt = { version: 1, caseId: config.caseId, harness: config.harness, runId,
    status: 'running', productionStoreMutated: config.deliveryMode === 'production_claim' }
  const scan = async () => {
    const current = await scanCanary(config.canarySha256, { environment })
    if (!config.previousCanarySha256) return current
    const previous = await scanCanary(config.previousCanarySha256, { environment })
    return { ...current, matched: current.matched || previous.matched, truncated: current.truncated || previous.truncated,
      files: current.files + previous.files, bytes: current.bytes + previous.bytes, unavailable: current.unavailable + previous.unavailable }
  }
  let phase = 'runtime_identity'
  try {
    const marker = '/opt/mikka/worker-source-sha', info = await lstat(marker)
    const workerSha = (await readFile(marker, 'utf8')).trim()
    const workerSourceCommit = /^\/opt\/mikka\/releases\/([a-f0-9]{40})\/source$/.exec(await realpath('/opt/mikka/worker'))?.[1]
    check(info.isFile() && info.uid === 0 && (info.mode & 0o222) === 0
      && workerSha === config.workerSha && workerSourceCommit === config.workerSourceCommit, 'runtime_mismatch')
    receipt.runtime = { workerSha, sourceCommit: workerSourceCommit, node: process.version }
    phase = 'canary_before'; receipt.before = await scan()
    check(!receipt.before.matched, 'canary_visible')
    if (config.deliveryMode === 'production_claim' && config.phase === 'revocation') {
      phase = 'production_claim'; receipt.http = await productionHttpProof(config, { environment, fetchImpl })
      // One bounded deadline keeps this real native child alive for the
      // owner's rotation/stop event. There is no repeated request or polling.
      // If it survives, this phase fails rather than counting its natural exit
      // as successful revocation. The runner separately enforces <=90 seconds.
      phase = 'revocation_deadline'
      await new Promise(resolve => setTimeout(resolve, 95_000))
      throw Error('production_revocation_not_observed')
    }
    phase = 'native_github'; receipt.github = await nativeGitProof(config, { execute })
    phase = 'protected_http'; receipt.http = config.deliveryMode === 'production_claim'
      ? await productionHttpProof(config, { environment, fetchImpl }) : await httpProof(config, runId, fetchImpl)
    phase = 'canary_after'; receipt.after = await scan()
    check(!receipt.after.matched, 'canary_visible')
    receipt.status = 'passed'
  } catch { receipt.status = 'failed'; receipt.failure = { phase } }
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let receipt
  try { receipt = await runNativeProbe(JSON.parse(process.argv[2])) }
  catch { receipt = { version: 1, status: 'failed', failure: { phase: 'configuration' } } }
  process.stdout.write(RECEIPT + JSON.stringify(receipt) + '\n')
  if (receipt.status !== 'passed') process.exitCode = 1
}

import { githubAppJwt } from '../../suggestions/github-redelivery'
import { githubRepository } from '../run-pull-request'
import type { Check, CommitStatus, RequiredCheck, Snapshot, WorkflowRun } from './snapshot'

type Binding = { remoteKey: string; installationId: number; repositoryId: number; prNumber: number; branch: string }
export class CiReadError extends Error {
  constructor(readonly code: 'configuration' | 'permission' | 'unavailable' | 'invalid_response' | 'unsupported_required_workflow') { super(code) }
}

/** Read only, fixed origin, installation- and repository-scoped. No token is retained. */
export async function readCi(binding: Binding, env: Record<string, string | undefined>, fetcher: typeof fetch = fetch, options: { deadline?: number } = {}): Promise<{ head: string; open: boolean; snapshot: Snapshot }> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !Number.isSafeInteger(binding.installationId) || binding.installationId <= 0 || !Number.isSafeInteger(binding.repositoryId) || binding.repositoryId <= 0 || !Number.isSafeInteger(binding.prNumber) || binding.prNumber <= 0 || !binding.branch || binding.branch.length > 255) throw new CiReadError('configuration')
  const { path } = githubRepository(binding.remoteKey)
  let jwt: string
  try { jwt = githubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY) } catch { throw new CiReadError('configuration') }
  async function request(pathname: string, token: string, body?: unknown): Promise<unknown> {
    let response: Response
    const remaining = options.deadline === undefined ? 8_000 : Math.min(8_000, options.deadline - Date.now())
    if (remaining <= 0) throw new CiReadError('unavailable')
    try { response = await fetcher(`https://api.github.com${pathname}`, { method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(remaining), headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, ...(body ? { body: JSON.stringify(body) } : {}) }) } catch { throw new CiReadError('unavailable') }
    if (response.status === 401 || response.status === 403 || response.status === 404) throw new CiReadError(response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0') ? 'unavailable' : 'permission')
    if (response.status === 422 && body) throw new CiReadError('permission')
    if (!response.ok) throw new CiReadError('unavailable')
    try { return await response.json() } catch { throw new CiReadError('invalid_response') }
  }
  const tokenResponse = await request(`/app/installations/${binding.installationId}/access_tokens`, jwt, { repository_ids: [binding.repositoryId], permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read', contents: 'read', actions: 'read' } }) as { token?: unknown }
  if (typeof tokenResponse?.token !== 'string' || !tokenResponse.token) throw new CiReadError('invalid_response')
  const token = tokenResponse.token
  const pr = await request(`${path}/pulls/${binding.prNumber}`, token) as { state?: unknown; head?: { sha?: unknown; ref?: unknown; repo?: { id?: unknown } }; base?: { ref?: unknown; repo?: { id?: unknown } } }
  if (!['open', 'closed'].includes(String(pr?.state)) || typeof pr.head?.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(pr.head.sha) || pr.base?.repo?.id !== binding.repositoryId || pr.head.ref !== binding.branch || pr.head.repo?.id !== binding.repositoryId || typeof pr.base?.ref !== 'string' || !pr.base.ref || pr.base.ref.length > 255) throw new CiReadError('invalid_response')
  if (pr.state === 'closed') return { head: pr.head.sha, open: false, snapshot: { checks: [], statuses: [] } }
  const checks: Check[] = []
  let total: number | undefined
  for (let page = 1; page <= 10; page++) {
    const data = await request(`${path}/commits/${pr.head.sha}/check-runs?filter=latest&per_page=100&page=${page}`, token) as { total_count?: unknown; check_runs?: unknown }
    if (!Number.isSafeInteger(data?.total_count) || !Array.isArray(data.check_runs)) throw new CiReadError('invalid_response')
    if (typeof data.total_count !== 'number' || (total !== undefined && total !== data.total_count)) throw new CiReadError('invalid_response')
    total = data.total_count
    for (const c of data.check_runs) {
      if (!c || !Number.isSafeInteger(c.id) || typeof c.name !== 'string' || typeof c.status !== 'string' || !(c.conclusion === null || typeof c.conclusion === 'string')) throw new CiReadError('invalid_response')
      checks.push({ id: String(c.id), name: c.name, status: c.status, conclusion: c.conclusion, appId: Number.isSafeInteger(c.app?.id) ? c.app.id : null, suiteId: Number.isSafeInteger(c.check_suite?.id) ? String(c.check_suite.id) : null })
    }
    if (data.check_runs.length < 100) {
      if (checks.length !== total) throw new CiReadError('invalid_response')
      break
    }
    if (page === 10) throw new CiReadError('invalid_response')
  }
  const combined = await request(`${path}/commits/${pr.head.sha}/status?per_page=100`, token) as { total_count?: unknown; statuses?: unknown }
  if (!Number.isSafeInteger(combined?.total_count) || !Array.isArray(combined.statuses) || combined.total_count !== combined.statuses.length) throw new CiReadError('invalid_response')
  const statuses: CommitStatus[] = combined.statuses.map(s => {
    if (!s || !Number.isSafeInteger(s.id) || typeof s.context !== 'string' || typeof s.state !== 'string') throw new CiReadError('invalid_response')
    return { id: String(s.id), context: s.context, state: s.state }
  })
  // Check the protected target branch and active rulesets, not just the checks
  // that have already registered on the head. The branch endpoint exposes
  // legacy protection with Contents read; missing details are not an empty set.
  const base = encodeURIComponent(pr.base.ref)
  const branch = await request(`${path}/branches/${base}`, token) as { protected?: unknown; protection?: { enabled?: unknown; required_status_checks?: { contexts?: unknown; checks?: unknown } } }
  if (typeof branch?.protected !== 'boolean' || !branch.protection || typeof branch.protection.enabled !== 'boolean') throw new CiReadError('invalid_response')
  const requiredChecks: RequiredCheck[] = []
  const add = (context: unknown, appId: unknown) => {
    if (typeof context !== 'string' || !context.trim() || context.length > 255 || !(appId == null || Number.isSafeInteger(appId))) throw new CiReadError('invalid_response')
    requiredChecks.push({ context, appId: typeof appId === 'number' && appId > 0 ? appId : null })
  }
  if (branch.protection.enabled) {
    const required = branch.protection.required_status_checks
    if (!required || !Array.isArray(required.contexts) || !Array.isArray(required.checks)) throw new CiReadError('invalid_response')
    for (const check of required.checks) { if (!check || typeof check !== 'object') throw new CiReadError('invalid_response'); add(check.context, check.app_id) }
    for (const context of required.contexts) {
      if (typeof context !== 'string') throw new CiReadError('invalid_response')
      if (!requiredChecks.some(check => check.context === context)) add(context, null)
    }
  }
  for (let page = 1; page <= 5; page++) {
    const rules = await request(`${path}/rules/branches/${base}?per_page=100&page=${page}`, token)
    if (!Array.isArray(rules)) throw new CiReadError('invalid_response')
    for (const rule of rules) {
      if (!rule || typeof rule.type !== 'string') throw new CiReadError('invalid_response')
      if (rule.type === 'required_status_checks') {
        if (!Array.isArray(rule.parameters?.required_status_checks)) throw new CiReadError('invalid_response')
        for (const check of rule.parameters.required_status_checks) { if (!check || typeof check !== 'object') throw new CiReadError('invalid_response'); add(check.context, check.integration_id) }
      }
      // Ruleset-required reusable workflows may run in a different repository.
      // Their absence cannot be established from this repository's runs.
      if (rule.type === 'workflows') throw new CiReadError('unsupported_required_workflow')
    }
    if (rules.length < 100) break
    if (page === 5) throw new CiReadError('invalid_response')
  }
  // GitHub Actions knows runs that have not yet registered any check run.
  const workflows: WorkflowRun[] = []
  let workflowTotal: number | undefined
  for (let page = 1; page <= 10; page++) {
    const data = await request(`${path}/actions/runs?head_sha=${pr.head.sha}&branch=${encodeURIComponent(binding.branch)}&per_page=100&page=${page}`, token) as { total_count?: unknown; workflow_runs?: unknown }
    if (typeof data?.total_count !== 'number' || !Number.isSafeInteger(data.total_count) || !Array.isArray(data.workflow_runs) || (workflowTotal !== undefined && workflowTotal !== data.total_count)) throw new CiReadError('invalid_response')
    workflowTotal = data.total_count
    for (const run of data.workflow_runs) {
      if (!run || !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || !Number.isSafeInteger(run.workflow_id) || typeof run.event !== 'string' || !run.event || typeof run.created_at !== 'string' || Number.isNaN(Date.parse(run.created_at)) || run.head_sha?.toLowerCase() !== pr.head.sha.toLowerCase() || run.head_branch !== binding.branch || typeof run.name !== 'string' || !run.name || typeof run.status !== 'string' || !(run.conclusion === null || typeof run.conclusion === 'string')) throw new CiReadError('invalid_response')
      workflows.push({ id: String(run.id), attempt: run.run_attempt, name: run.name, status: run.status, conclusion: run.conclusion, workflowId: String(run.workflow_id), event: run.event, createdAt: run.created_at, suiteId: Number.isSafeInteger(run.check_suite_id) ? String(run.check_suite_id) : null })
    }
    if (data.workflow_runs.length < 100) { if (workflows.length !== workflowTotal) throw new CiReadError('invalid_response'); break }
    if (page === 10) throw new CiReadError('invalid_response')
  }
  return { head: pr.head.sha, open: true, snapshot: { checks, statuses, workflows, requiredChecks } }
}

/** At most ten pending GitHub Actions runs are refreshed in one reconciliation.
 * The caller persists these observations with its generation fence before using
 * them. Missing, changed or inaccessible provider state is never completion. */
export async function readPendingCiAttempts(binding: Binding, head: string, attempts: readonly import('./attempts').WorkflowAttempt[], env: Record<string, string | undefined>, fetcher: typeof fetch = fetch, options: { deadline?: number } = {}): Promise<import('./attempts').WorkflowAttempt[]> {
  const pending = attempts.filter(a => a.state !== 'completed').slice(0, 10)
  if (!pending.length) return []
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !Number.isSafeInteger(binding.installationId) || binding.installationId <= 0 || !Number.isSafeInteger(binding.repositoryId) || binding.repositoryId <= 0 || !/^[a-f0-9]{40}$/i.test(head) || !binding.branch || binding.branch.length > 255) throw new CiReadError('configuration')
  const { path } = githubRepository(binding.remoteKey)
  let jwt: string
  try { jwt = githubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY) } catch { throw new CiReadError('configuration') }
  async function request(pathname: string, token: string, body?: unknown): Promise<unknown> {
    const remaining = options.deadline === undefined ? 8_000 : Math.min(8_000, options.deadline - Date.now())
    if (remaining <= 0) throw new CiReadError('unavailable')
    let response: Response
    try {
      response = await fetcher(`https://api.github.com${pathname}`, { method: body ? 'POST' : 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(remaining), headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { throw new CiReadError('unavailable') }
    if (response.status === 401 || response.status === 403 || response.status === 404) throw new CiReadError(response.status === 403 && (response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0') ? 'unavailable' : 'permission')
    if (response.status === 422 && body) throw new CiReadError('permission')
    if (!response.ok) throw new CiReadError('unavailable')
    try { return await response.json() } catch { throw new CiReadError('invalid_response') }
  }
  const tokenResponse = await request(`/app/installations/${binding.installationId}/access_tokens`, jwt, { repository_ids: [binding.repositoryId], permissions: { metadata: 'read', actions: 'read' } }) as { token?: unknown }
  if (typeof tokenResponse?.token !== 'string' || !tokenResponse.token) throw new CiReadError('invalid_response')
  const result: import('./attempts').WorkflowAttempt[] = []
  for (const prior of pending) {
    if (options.deadline !== undefined && Date.now() >= options.deadline && result.length) break
    if (!/^[1-9][0-9]*$/.test(prior.runId) || !Number.isSafeInteger(Number(prior.runId)) || !Number.isSafeInteger(prior.attempt) || prior.attempt < 1) throw new CiReadError('invalid_response')
    let raw: unknown
    try { raw = await request(`${path}/actions/runs/${prior.runId}`, tokenResponse.token) }
    catch (error) {
      if (error instanceof CiReadError && error.code === 'unavailable' && result.length && options.deadline !== undefined && Date.now() >= options.deadline) break
      throw error
    }
    const run = raw as { id?: unknown; head_sha?: unknown; head_branch?: unknown; run_attempt?: unknown; status?: unknown; repository?: { id?: unknown } }
    if (!Number.isSafeInteger(run?.id) || String(run.id) !== prior.runId || typeof run.head_sha !== 'string' || run.head_sha.toLowerCase() !== head.toLowerCase() || run.head_branch !== binding.branch || run.repository?.id !== binding.repositoryId || typeof run.run_attempt !== 'number' || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < prior.attempt) throw new CiReadError('invalid_response')
    const state = run.status === 'completed' ? 'completed' : run.status === 'in_progress' ? 'in_progress' : ['queued', 'requested', 'waiting', 'pending'].includes(String(run.status)) ? 'requested' : null
    if (!state) throw new CiReadError('invalid_response')
    result.push({ runId: prior.runId, attempt: run.run_attempt, state })
  }
  return result
}

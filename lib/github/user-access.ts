import 'server-only'
import { auth } from '@/lib/auth'
import { githubConnectionToken } from './connection'
import { readGitHubAppConfig } from './app-config'

export { GitHubAccessError, type GitHubAccessCode } from './user-access-error'
import { GitHubAccessError } from './user-access-error'
import { noteGitHubRequest } from '@/lib/dispatch-timing'
import { remainingRequestBudget, requestBudgetSignal, type RequestBudget } from '../request-budget'
import { githubRepository } from './run-pull-request'

export type AuthorizedGitHubRepository = { id: string; installationId: string; fullName: string; htmlUrl: string; private: boolean; description?: string | null; homepage?: string | null; pushedAt?: string | null }
type Json = Record<string, unknown>
const API = 'https://api.github.com'
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GitHubAccessError('githubUnavailable', 502)
  return value as Json
}

function githubId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value
  throw new GitHubAccessError('githubUnavailable', 502)
}

async function githubGet(token: string, path: string, budget?: RequestBudget): Promise<{ data: Json; next: boolean }> {
  const started = Date.now()
  try { return await githubRequest(token, path, budget) } finally { noteGitHubRequest(Date.now() - started) }
}

async function githubRequest(token: string, path: string, budget?: RequestBudget): Promise<{ data: Json; next: boolean }> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' },
      cache: 'no-store', redirect: 'error', signal: budget ? requestBudgetSignal(budget) : AbortSignal.timeout(10_000),
    })
  // error-cause: transport errors may retain the bearer Authorization header.
  } catch { throw new GitHubAccessError('githubUnavailable', 502) }
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 401) throw new GitHubAccessError('githubReconnectRequired', 401)
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') !== '0' && !response.headers.has('retry-after')) throw new GitHubAccessError('githubRepositoryForbidden', 403)
    if (response.status === 404) throw new GitHubAccessError('githubRepositoryForbidden', 403)
    throw new GitHubAccessError('githubUnavailable', 502)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new GitHubAccessError('githubUnavailable', 502)
  try {
    let bytes = 0; const chunks: Uint8Array[] = []
    while (true) {
      if (budget) remainingRequestBudget(budget)
      const part = await reader.read(); if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 4 * 1024 * 1024) throw new GitHubAccessError('githubUnavailable', 502)
      chunks.push(part.value)
    }
    return { data: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))), next: /rel="next"/.test(response.headers.get('link') ?? '') }
  // error-cause: JSON and stream errors can quote private repository or account response bodies.
  } catch { await reader.cancel().catch(() => {}); throw new GitHubAccessError('githubUnavailable', 502) }
  finally { reader.releaseLock() }
}

/** The Plugins → GitHub connection first; a GitHub sign-in account linked before connections existed still works.
 * Without request headers (the Coordinator acts for a user id), the legacy account is read server-side for that user only. */
async function userToken(userId: string, headers?: Headers, minValidityMs?: number, budget?: RequestBudget): Promise<{ token: string; githubAccountId: string; expiresAt: Date | null }> {
  if (budget) remainingRequestBudget(budget)
  let connected: Awaited<ReturnType<typeof githubConnectionToken>>
  try { connected = await githubConnectionToken(userId, { ...(minValidityMs === undefined ? {} : { minValidityMs }), ...(budget ? { budget } : {}) }) }
  catch (error) {
    if (error instanceof DOMException || (error && typeof error === 'object' && 'code' in error && ['55P03', '57014'].includes(String(error.code))))
      // error-cause: connection failures can include encrypted credentials or token refresh parameters.
      throw new GitHubAccessError('githubUnavailable', 502)
    // error-cause: connection decryption/refresh failures can quote token material.
    throw new GitHubAccessError('githubReconnectRequired', 401)
  }
  if (budget) remainingRequestBudget(budget)
  if (connected) return connected
  const accounts: { id: string; userId: string; providerId: string; accountId: string }[] = headers
    ? await auth.api.listUserAccounts({ headers })
    : await (await auth.$context).internalAdapter.findAccounts(userId)
  const account = accounts.find(row => row.providerId === 'github' && row.userId === userId)
  if (!account) throw new GitHubAccessError('githubNotConnected', 409)
  // The legacy library may rotate here. Reserve its full independent 10s
  // HTTP window and persistence, and never race/abandon an in-flight refresh.
  if (budget) remainingRequestBudget(budget, 12_000)
  try {
    // Better Auth takes the internal account row id and decrypts its token. With no
    // headers it looks the account up under body.userId, which only the host sets.
    const access = await auth.api.getAccessToken(headers ? { headers, body: { accountId: account.id } } : { body: { accountId: account.id, userId } })
    if (budget) remainingRequestBudget(budget)
    if (!access.accessToken) throw new Error('missingToken')
    return { token: access.accessToken, githubAccountId: account.accountId, expiresAt: access.accessTokenExpiresAt ? new Date(access.accessTokenExpiresAt) : null }
  } catch (error) {
    // error-cause: the auth library's transport failure may retain OAuth request credentials.
    if (error instanceof DOMException) throw new GitHubAccessError('githubUnavailable', 502)
    // error-cause: the auth library's provider failure can include an OAuth response body.
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 500) throw new GitHubAccessError('githubUnavailable', 502)
    // error-cause: auth/decryption failures can quote the access or refresh token.
    throw new GitHubAccessError('githubReconnectRequired', 401)
  }
}

/**
 * The person's own GitHub user token for server code acting for a user id with
 * no browser request: their runs, the Coordinator. Checked against their
 * linked GitHub id. It never reaches chat, logs, memory or an error message.
 */
export async function githubTokenForUser(userId: string, options: { minValidityMs?: number; budget?: RequestBudget } = {}): Promise<{ token: string; githubAccountId: string; expiresAt: Date | null }> {
  const credential = await userToken(userId, undefined, options.minValidityMs, options.budget)
  if (githubId((await githubGet(credential.token, '/user', options.budget)).data.id) !== credential.githubAccountId) throw new GitHubAccessError('githubReconnectRequired', 401)
  return credential
}

/** The signed-in person's own GitHub user token, checked against their GitHub id. Never an app or installation token. */
export async function githubUserToken(headers: Headers) {
  const session = await auth.api.getSession({ headers })
  if (!session?.user) throw new GitHubAccessError('authRequired', 401)
  const { token, githubAccountId } = await userToken(session.user.id, headers)
  if (githubId((await githubGet(token, '/user')).data.id) !== githubAccountId) throw new GitHubAccessError('githubReconnectRequired', 401)
  return { userId: session.user.id, githubAccountId, token }
}

async function authorizedRepositories(headers: Headers) {
  const session = await auth.api.getSession({ headers })
  if (!session?.user) throw new GitHubAccessError('authRequired', 401)
  const { login: _login, installationAccounts: _accounts, ...result } = await repositoriesForUser(session.user.id, headers)
  return { userId: session.user.id, ...result }
}

/** What this one user's own GitHub token reaches through the Mikka App: the live source the Plugins page shows. */
async function repositoriesForUser(userId: string, headers?: Headers, options: { budget?: RequestBudget; localAppOnly?: boolean } = {}) {
  const cloud = options.localAppOnly ? null : await (await import('./cloud')).cloudGitHubRepositories(userId)
  if (cloud) return cloud
  const appId = (await readGitHubAppConfig()).id
  if (!appId || !/^[1-9]\d*$/.test(appId)) throw new GitHubAccessError('githubNotConfigured', 503)
  const { token, githubAccountId } = await userToken(userId, headers, undefined, options.budget)
  let requests = 0
  const get = (path: string) => {
    // One aggregate cap, not a 100-by-100 nested installation/repository cap.
    if (++requests > 100) throw new GitHubAccessError('githubUnavailable', 502)
    return githubGet(token, path, options.budget)
  }
  // Both reads use the one fresh token. Settle both before validating identity
  // first: an identity refusal may already have sent the read-only first page.
  const [identityRead, firstPage] = await Promise.allSettled([
    get('/user'), get('/user/installations?per_page=100&page=1'),
  ])
  if (identityRead.status === 'rejected') throw identityRead.reason
  const identity = identityRead.value.data
  if (githubId(identity.id) !== githubAccountId) throw new GitHubAccessError('githubReconnectRequired', 401)
  if (firstPage.status === 'rejected') throw firstPage.reason
  const login = typeof identity.login === 'string' && identity.login ? identity.login : null
  const installationAccounts: string[] = []
  const installations: string[] = []
  const repositories: AuthorizedGitHubRepository[] = []
  for (let page = 1; ; page++) {
    const result = page === 1 ? firstPage.value : await get(`/user/installations?per_page=100&page=${page}`)
    if (!Array.isArray(result.data.installations)) throw new GitHubAccessError('githubUnavailable', 502)
    for (const value of result.data.installations) {
      const installation = object(value)
      if (githubId(installation.app_id) !== appId || installation.suspended_at != null) continue
      const installationId = githubId(installation.id)
      installations.push(installationId)
      const owner = installation.account && typeof installation.account === 'object' ? (installation.account as Json).login : null
      if (typeof owner === 'string' && owner) installationAccounts.push(owner)
      for (let repoPage = 1; ; repoPage++) {
        const repos = await get(`/user/installations/${installationId}/repositories?per_page=100&page=${repoPage}`)
        if (!Array.isArray(repos.data.repositories)) throw new GitHubAccessError('githubUnavailable', 502)
        for (const value of repos.data.repositories) {
          if (value == null) continue
          const repo = object(value)
          if (typeof repo.full_name !== 'string' || !REPO_NAME.test(repo.full_name) || typeof repo.private !== 'boolean') throw new GitHubAccessError('githubUnavailable', 502)
          // What the repository says it is, so a name shared by several ("Mikka", mikka-web) can be told apart.
          const text = (field: unknown) => typeof field === 'string' && field.trim() ? field.trim().slice(0, 300) : null
          repositories.push({ id: githubId(repo.id), installationId, fullName: repo.full_name, htmlUrl: `https://github.com/${repo.full_name}`, private: repo.private, description: text(repo.description), homepage: text(repo.homepage), pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null })
        }
        if (!repos.next) break
      }
    }
    if (!result.next) break
  }
  return { githubAccountId, login, installationAccounts, installations, repositories, token }
}

/** Server-only, request-scoped read authority for this viewer and one frozen
 * repository. A cloud installation token may read, but is never a human write
 * credential. No cache or second user-token lookup substitutes for this check. */
export async function githubRepositoryReadCredential(userId: string, remoteKey: string, budget?: RequestBudget): Promise<{
  token: string; repository: AuthorizedGitHubRepository; kind: 'user' | 'installation'; githubAccountId: string | null;
}> {
  if (budget) remainingRequestBudget(budget)
  let repo: ReturnType<typeof githubRepository>
  // error-cause: repository parsing errors can include a credential-bearing remote URL.
  try { repo = githubRepository(remoteKey) } catch { throw new GitHubAccessError('githubRepositoryForbidden', 403) }
  const cloud = await import('./cloud')
  const fromCloud = await cloud.useCloudGitHub(userId)
  let token: string, installationId: string, githubAccountId: string | null, expectedId: string | undefined
  if (fromCloud) {
    const credential = await cloud.cloudGitHubCredential(userId, remoteKey, budget)
    if (!credential) throw new GitHubAccessError('githubNotConnected', 409)
    token = credential.token; installationId = credential.installationId; githubAccountId = credential.githubAccountId ?? null
  } else {
    const access = await repositoriesForUser(userId, undefined, { budget, localAppOnly: true })
    const selected = access.repositories.find(item => item.fullName.toLowerCase() === `${repo.owner}/${repo.repo}`)
    if (!selected || !access.token) throw new GitHubAccessError('githubRepositoryForbidden', 403)
    token = access.token; installationId = selected.installationId; githubAccountId = access.githubAccountId; expectedId = selected.id
  }
  const current = (await githubGet(token, repo.path, budget)).data
  const id = githubId(current.id)
  if (typeof current.full_name !== 'string' || current.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`
    || typeof current.private !== 'boolean' || (expectedId !== undefined && expectedId !== id)) throw new GitHubAccessError('githubRepositoryForbidden', 403)
  return { token, repository: { id, installationId, fullName: current.full_name, htmlUrl: `https://github.com/${current.full_name}`, private: current.private },
    kind: fromCloud ? 'installation' : 'user', githubAccountId }
}

/** For server code acting for a user id with no browser request (the Coordinator). Never returns the token. */
export async function listRepositoriesForUser(userId: string) {
  const { token: _token, ...result } = await repositoriesForUser(userId)
  return result
}

/** Live GitHub user/App repository intersection; no access is inferred from installation redirect parameters. */
export async function listAuthorizedRepositories(headers: Headers) {
  const { token: _token, ...result } = await authorizedRepositories(headers)
  return result
}

export async function readAuthorizedPullRequest(headers: Headers, url: string) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url)
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new GitHubAccessError('githubPullRequestInvalid', 400)
  const number = Number(match[2])
  const access = await authorizedRepositories(headers)
  const repo = access.repositories.find(item => item.fullName.toLowerCase() === match[1].toLowerCase())
  if (!repo) throw new GitHubAccessError('githubRepositoryForbidden', 403)
  const token = access.token ?? (await (await import('./cloud')).cloudGitHubCredential(access.userId, `v2/github.com/${repo.fullName.toLowerCase()}`))?.token
  if (!token) throw new GitHubAccessError('githubNotConnected', 409)
  const pr = (await githubGet(token, `/repos/${repo.fullName}/pulls/${number}`)).data
  const baseRepo = object(object(pr.base).repo)
  if (pr.number !== number || githubId(baseRepo.id) !== repo.id || (pr.state !== 'open' && pr.state !== 'closed') || typeof pr.updated_at !== 'string' || !Number.isFinite(Date.parse(pr.updated_at))) throw new GitHubAccessError('githubUnavailable', 502)
  const state: 'open' | 'closed' | 'merged' = pr.state === 'closed' && (pr.merged === true || typeof pr.merged_at === 'string') ? 'merged' : pr.state
  // These timestamps are the provider's event times, not the PR's mutable updated_at.
  // Keep them nullable so consumers can omit an event whose source time is unavailable.
  const eventTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
  const title = typeof pr.title === 'string' && pr.title.length <= 256 ? pr.title : null
  return { userId: access.userId, githubAccountId: access.githubAccountId, repoId: repo.id, installationId: repo.installationId, number, url: `https://github.com/${repo.fullName}/pull/${number}`, state, updatedAt: pr.updated_at, title, createdAt: eventTime(pr.created_at), mergedAt: eventTime(pr.merged_at) }
}

/** Existing issue readback only. A repository selection or PR URL never proves
 * a GitHub issue mapping, and provider bodies/tokens are not returned. */
export async function readAuthorizedIssue(headers: Headers, url: string) {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url)
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new GitHubAccessError('githubIssueInvalid', 400)
  const number = Number(match[2])
  const access = await authorizedRepositories(headers)
  const repo = access.repositories.find(item => item.fullName.toLowerCase() === match[1].toLowerCase())
  if (!repo) throw new GitHubAccessError('githubRepositoryForbidden', 403)
  const token = access.token ?? (await (await import('./cloud')).cloudGitHubCredential(access.userId, `v2/github.com/${repo.fullName.toLowerCase()}`))?.token
  if (!token) throw new GitHubAccessError('githubNotConnected', 409)
  const issue = (await githubGet(token, `/repos/${repo.fullName}/issues/${number}`)).data
  const canonical = `https://github.com/${repo.fullName}/issues/${number}`
  if (issue.pull_request != null || issue.number !== number || typeof issue.html_url !== 'string' || issue.html_url.toLowerCase() !== canonical.toLowerCase() ||
      (issue.state !== 'open' && issue.state !== 'closed') || typeof issue.updated_at !== 'string' || !Number.isFinite(Date.parse(issue.updated_at))) throw new GitHubAccessError('githubUnavailable', 502)
  return { userId: access.userId, githubAccountId: access.githubAccountId, repoId: repo.id, installationId: repo.installationId, issueId: githubId(issue.id), number, url: canonical, state: issue.state, updatedAt: issue.updated_at }
}

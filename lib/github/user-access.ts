import 'server-only'
import { auth } from '@/lib/auth'

export type GitHubAccessCode = 'authRequired' | 'githubNotConfigured' | 'githubNotConnected' | 'githubReconnectRequired' | 'githubRepositoryForbidden' | 'githubPullRequestInvalid' | 'githubIssueInvalid' | 'githubUnavailable'

export class GitHubAccessError extends Error {
  constructor(readonly code: GitHubAccessCode, readonly status: number) {
    super(code)
    this.name = 'GitHubAccessError'
  }
}

export type AuthorizedGitHubRepository = { id: string; installationId: string; fullName: string; htmlUrl: string; private: boolean }
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

async function githubGet(token: string, path: string): Promise<{ data: Json; next: boolean }> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
  } catch { throw new GitHubAccessError('githubUnavailable', 502) }
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 401) throw new GitHubAccessError('githubReconnectRequired', 401)
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') !== '0') throw new GitHubAccessError('githubRepositoryForbidden', 403)
    if (response.status === 404) throw new GitHubAccessError('githubRepositoryForbidden', 403)
    throw new GitHubAccessError('githubUnavailable', 502)
  }
  try { return { data: object(await response.json()), next: /rel="next"/.test(response.headers.get('link') ?? '') } }
  catch { throw new GitHubAccessError('githubUnavailable', 502) }
}

async function authorizedRepositories(headers: Headers) {
  const session = await auth.api.getSession({ headers })
  if (!session?.user) throw new GitHubAccessError('authRequired', 401)
  const appId = process.env.GITHUB_APP_ID
  if (!appId || !/^[1-9]\d*$/.test(appId)) throw new GitHubAccessError('githubNotConfigured', 503)
  const accounts = await auth.api.listUserAccounts({ headers })
  const account = accounts.find(row => row.providerId === 'github' && row.userId === session.user.id)
  if (!account) throw new GitHubAccessError('githubNotConnected', 409)
  let token: string
  try {
    // Better Auth takes the internal account row id and decrypts its token.
    token = (await auth.api.getAccessToken({ headers, body: { accountId: account.id } })).accessToken
    if (!token) throw new Error('missingToken')
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 500) throw new GitHubAccessError('githubUnavailable', 502)
    throw new GitHubAccessError('githubReconnectRequired', 401)
  }
  const identity = (await githubGet(token, '/user')).data
  if (githubId(identity.id) !== account.accountId) throw new GitHubAccessError('githubReconnectRequired', 401)
  const installations: string[] = []
  const repositories: AuthorizedGitHubRepository[] = []
  for (let page = 1; ; page++) {
    const result = await githubGet(token, `/user/installations?per_page=100&page=${page}`)
    if (!Array.isArray(result.data.installations)) throw new GitHubAccessError('githubUnavailable', 502)
    for (const value of result.data.installations) {
      const installation = object(value)
      if (githubId(installation.app_id) !== appId || installation.suspended_at != null) continue
      const installationId = githubId(installation.id)
      installations.push(installationId)
      for (let repoPage = 1; ; repoPage++) {
        const repos = await githubGet(token, `/user/installations/${installationId}/repositories?per_page=100&page=${repoPage}`)
        if (!Array.isArray(repos.data.repositories)) throw new GitHubAccessError('githubUnavailable', 502)
        for (const value of repos.data.repositories) {
          if (value == null) continue
          const repo = object(value)
          if (typeof repo.full_name !== 'string' || !REPO_NAME.test(repo.full_name) || typeof repo.private !== 'boolean') throw new GitHubAccessError('githubUnavailable', 502)
          repositories.push({ id: githubId(repo.id), installationId, fullName: repo.full_name, htmlUrl: `https://github.com/${repo.full_name}`, private: repo.private })
        }
        if (!repos.next) break
      }
    }
    if (!result.next) break
  }
  return { userId: session.user.id, githubAccountId: account.accountId, installations, repositories, token }
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
  const pr = (await githubGet(access.token, `/repos/${repo.fullName}/pulls/${number}`)).data
  const baseRepo = object(object(pr.base).repo)
  if (pr.number !== number || githubId(baseRepo.id) !== repo.id || (pr.state !== 'open' && pr.state !== 'closed') || typeof pr.updated_at !== 'string' || !Number.isFinite(Date.parse(pr.updated_at))) throw new GitHubAccessError('githubUnavailable', 502)
  const state: 'open' | 'closed' | 'merged' = pr.state === 'closed' && (pr.merged === true || typeof pr.merged_at === 'string') ? 'merged' : pr.state
  return { userId: access.userId, githubAccountId: access.githubAccountId, repoId: repo.id, installationId: repo.installationId, number, url: `https://github.com/${repo.fullName}/pull/${number}`, state, updatedAt: pr.updated_at }
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
  const issue = (await githubGet(access.token, `/repos/${repo.fullName}/issues/${number}`)).data
  const canonical = `https://github.com/${repo.fullName}/issues/${number}`
  if (issue.pull_request != null || issue.number !== number || typeof issue.html_url !== 'string' || issue.html_url.toLowerCase() !== canonical.toLowerCase() ||
      (issue.state !== 'open' && issue.state !== 'closed') || typeof issue.updated_at !== 'string' || !Number.isFinite(Date.parse(issue.updated_at))) throw new GitHubAccessError('githubUnavailable', 502)
  return { userId: access.userId, githubAccountId: access.githubAccountId, repoId: repo.id, installationId: repo.installationId, issueId: githubId(issue.id), number, url: canonical, state: issue.state, updatedAt: issue.updated_at }
}

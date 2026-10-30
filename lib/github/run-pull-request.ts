import { z } from 'zod'
import { githubAppJwt } from '@/lib/suggestions/github-redelivery'
import { pullRequestBody } from '@mikka/protocol/orchestrator'
import { normalizeRepository } from '@mikka/protocol/repository'

import { PublicationError, type PublicationErrorCode, type PublishedPullRequest } from '@/lib/run-publication-result'
export { PublicationError, PUBLICATION_ERRORS, type PublicationErrorCode, type PublishedPullRequest } from '@/lib/run-publication-result'

export interface GitHubRepositoryBinding {
  installationId: number
  repositoryId: number
  githubAccountId: string
  defaultBranch: string
}
type Options = {
  remoteKey: string
  githubAccountId: string | null
  env?: Record<string, string | undefined>
  fetcher?: typeof fetch
}

const id = z.number().int().positive().refine(Number.isSafeInteger)
const repoName = /^[a-z0-9_.-]+$/i
const installationSchema = z.object({
  id, suspended_at: z.string().nullable(),
  permissions: z.object({ pull_requests: z.string().optional(), contents: z.string().optional() }),
})
const tokenSchema = z.object({ token: z.string().min(1) })
const repositorySchema = z.object({ id, full_name: z.string(), default_branch: z.string().min(1) })
const userSchema = z.object({ id, login: z.string().regex(/^[a-z0-9-]+$/i) })
const permissionSchema = z.object({ permission: z.string(), user: userSchema })
const prSchema = z.object({
  number: id, html_url: z.string(), state: z.enum(['open', 'closed']), draft: z.boolean(),
  title: z.string().max(256).optional(),
  node_id: z.string().min(1).optional(),
  merged_at: z.string().nullable(), body: z.string().nullable(),
  head: z.object({ ref: z.string(), repo: z.object({ id }).nullable() }),
  base: z.object({ repo: z.object({ id }) }),
})

export function githubRepository(key: string) {
  const [version, host, owner, repo, extra] = key.split('/')
  if (version !== 'v2' || host !== 'github.com' || !owner || !repo || extra !== undefined || !repoName.test(owner) || !repoName.test(repo) || [owner, repo].some(value => value === '.' || value === '..')) {
    throw new PublicationError('repository_not_github')
  }
  try {
    if (normalizeRepository(`https://${host}/${owner}/${repo}.git`).key !== key) throw new Error('Noncanonical key')
  } catch { throw new PublicationError('repository_not_github') }
  return { owner, repo, path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new PublicationError('github_request_failed')
  return parsed.data
}

/** The URL and redirects are fixed; no caller can send an App credential to a git URL. */
function api(fetcher: typeof fetch) {
  return async (path: string, token: string, init: { method?: 'GET' | 'POST'; body?: unknown; missing?: PublicationErrorCode } = {}) => {
    let response: Response
    try {
      response = await fetcher(`https://api.github.com${path}`, {
        method: init.method ?? 'GET', redirect: 'error', cache: 'no-store',
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(8_000),
      })
    } catch { throw new PublicationError('github_unavailable', true) }
    if (response.status === 429 || response.status >= 500 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) {
      throw new PublicationError('github_unavailable', true)
    }
    if (response.status === 404 && init.missing) throw new PublicationError(init.missing, init.missing === 'branch_not_pushed')
    if (!response.ok) throw new PublicationError('github_request_failed')
    try { return await response.json() as unknown }
    catch { throw new PublicationError('github_request_failed') }
  }
}

async function repositoryAccess(options: Options) {
  const repo = githubRepository(options.remoteKey)
  if (!options.githubAccountId || !/^[1-9][0-9]*$/.test(options.githubAccountId)) throw new PublicationError('github_identity_required')
  const env = options.env ?? process.env
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new PublicationError('github_not_configured')
  let jwt: string
  try { jwt = githubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY) }
  catch { throw new PublicationError('github_not_configured') }
  const request = api(options.fetcher ?? fetch)
  const installation = parse(installationSchema, await request(`${repo.path}/installation`, jwt, { missing: 'github_not_installed' }))
  if (installation.suspended_at) throw new PublicationError('github_suspended')
  if (installation.permissions.pull_requests !== 'write' || !['read', 'write'].includes(installation.permissions.contents ?? '')) throw new PublicationError('github_permission_required')
  // Verify the person's durable GitHub identity with a read-only token first.
  // Only after that check may the server issue a token that can open a PR.
  const metadataToken = parse(tokenSchema, await request(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: 'POST', body: { repositories: [repo.repo], permissions: { metadata: 'read', contents: 'read' } },
  })).token
  const githubUser = parse(userSchema, await request(`/user/${options.githubAccountId}`, metadataToken, { missing: 'github_access_denied' }))
  if (String(githubUser.id) !== options.githubAccountId) throw new PublicationError('github_access_denied')
  const permission = parse(permissionSchema, await request(`${repo.path}/collaborators/${encodeURIComponent(githubUser.login)}/permission`, metadataToken, { missing: 'github_access_denied' }))
  if (String(permission.user.id) !== options.githubAccountId || !['write', 'admin'].includes(permission.permission)) throw new PublicationError('github_access_denied')
  const repository = parse(repositorySchema, await request(repo.path, metadataToken, { missing: 'github_not_installed' }))
  if (repository.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) throw new PublicationError('github_access_denied')
  const binding: GitHubRepositoryBinding = { installationId: installation.id, repositoryId: repository.id, githubAccountId: options.githubAccountId, defaultBranch: repository.default_branch }
  return { ...repo, request, jwt, metadataToken, binding }
}

/** A non-secret owner/repository installation receipt; never an access token. */
export async function verifyGitHubRepositoryAccess(options: Options): Promise<GitHubRepositoryBinding> {
  return (await repositoryAccess(options)).binding
}

/**
 * One PR per task branch (ADR 0024). Replays and ambiguous POST responses
 * first find the issue-marked PR; a human's unrelated PR is never adopted.
 * Every retry rechecks the live installation and the person's permission.
 */
export async function openRunPullRequest(options: Options & {
  issueId: string; identifier: string; title: string; summary: string
  branch: string; commit: string; baseBranch: string | null
  allowCreate?: boolean
  draft?: boolean
  onVerified?: (binding: GitHubRepositoryBinding) => Promise<void>
  /** The host holds current task/approval authority for each bounded write. */
  withWrite?: <T>(write: () => Promise<T>) => Promise<T>
}): Promise<PublishedPullRequest> {
  if (!/^mikka\/[a-z0-9-]+-[1-9][0-9]*$/.test(options.branch) || !/^[a-f0-9]{40,64}$/i.test(options.commit) || !z.uuid().safeParse(options.issueId).success) throw new PublicationError('publication_mismatch')
  const access = await repositoryAccess(options)
  const { request, path, binding } = access
  await options.onVerified?.(binding)
  const ref = parse(z.object({ object: z.object({ sha: z.string() }) }), await request(`${path}/git/ref/heads/${options.branch.split('/').map(encodeURIComponent).join('/')}`, access.metadataToken, { missing: 'branch_not_pushed' }))
  if (ref.object.sha.toLowerCase() !== options.commit.toLowerCase()) throw new PublicationError('branch_changed')
  const writeToken = parse(tokenSchema, await request(`/app/installations/${binding.installationId}/access_tokens`, access.jwt, {
    method: 'POST', body: { repository_ids: [binding.repositoryId], permissions: { metadata: 'read', pull_requests: 'write' } },
  })).token
  const marker = `<!-- mikka-issue:${options.issueId} -->`
  const write = <T>(operation: () => Promise<T>) => options.withWrite ? options.withWrite(operation) : operation()
  const result = async (raw: unknown): Promise<PublishedPullRequest> => {
    const pr = parse(prSchema, raw)
    if (pr.head.ref !== options.branch || pr.head.repo?.id !== binding.repositoryId || pr.base.repo.id !== binding.repositoryId || !pr.body?.trimEnd().endsWith(marker)) throw new PublicationError('pull_request_conflict')
    const expected = `https://github.com/${access.owner}/${access.repo}/pull/${pr.number}`
    if (pr.html_url.toLowerCase() !== expected.toLowerCase()) throw new PublicationError('github_request_failed')
    // A later unverified run must not leave an earlier ready-for-review PR open.
    // Only a task-marked PR may be converted; never reopen a closed/merged PR.
    if (options.draft && pr.state === 'open' && !pr.draft && !pr.merged_at) {
      if (!pr.node_id) throw new PublicationError('github_request_failed')
      const converted = parse(z.object({ data: z.object({ convertPullRequestToDraft: z.object({ pullRequest: z.object({ id: z.string(), isDraft: z.literal(true) }) }) }) }), await write(() => request('/graphql', writeToken, {
        method: 'POST', body: {
          query: 'mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }',
          variables: { id: pr.node_id },
        },
      })))
      if (converted.data.convertPullRequestToDraft.pullRequest.id !== pr.node_id) throw new PublicationError('github_request_failed')
      return { url: pr.html_url, ...(pr.title ? { title: pr.title } : {}), state: 'draft' }
    }
    return { url: pr.html_url, ...(pr.title ? { title: pr.title } : {}), state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open' }
  }
  const find = async () => {
    const query = new URLSearchParams({ state: 'all', head: `${access.owner}:${options.branch}`, per_page: '100', sort: 'created', direction: 'desc' })
    const rows = parse(z.array(prSchema), await request(`${path}/pulls?${query}`, writeToken))
    const matching = rows.filter(pr => pr.head.ref === options.branch && pr.head.repo?.id === binding.repositoryId)
    if (!matching.length) return null
    const own = matching.find(pr => pr.body?.trimEnd().endsWith(marker))
    if (!own) throw new PublicationError('pull_request_conflict')
    return result(own)
  }
  const existing = await find()
  if (existing) return existing
  if (options.allowCreate === false) throw new PublicationError('pull_request_limit')
  try {
    return await result(await write(() => request(`${path}/pulls`, writeToken, { method: 'POST', body: {
      title: `${options.identifier}: ${options.title}`.slice(0, 256),
      head: options.branch, base: options.baseBranch ?? binding.defaultBranch,
      ...(options.draft ? { draft: true } : {}),
      body: `${pullRequestBody(undefined, { key: options.identifier, title: options.title, summary: options.summary })}${options.draft ? '\n\nVerification was not run: no repository verification command is configured. This draft needs human review.' : ''}\n\n${marker}`,
    } })))
  } catch (error) {
    // A timeout or 422 may mean GitHub accepted another concurrent attempt.
    const created = await find()
    if (created) return created
    throw error
  }
}

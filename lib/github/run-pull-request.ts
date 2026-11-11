import { z } from 'zod'
import { pullRequestBody } from '@mikka/protocol/orchestrator'
import { normalizeRepository } from '@mikka/protocol/repository'
import { readReviewChecks } from './review-checks'

import { PublicationError, type PublicationErrorCode, type PublishedPullRequest } from '@/lib/run-publication-result'
export { PublicationError, PUBLICATION_ERRORS, type PublicationErrorCode, type PublishedPullRequest } from '@/lib/run-publication-result'

/** What the person's own token reads back about the repository; never a token. */
export interface GitHubRepositoryBinding {
  repositoryId: number
  githubAccountId: string | null
  defaultBranch: string
}
type Options = {
  remoteKey: string
  /** The run owner's own GitHub user token (lib/github/user-access.ts), and the GitHub account it must belong to. */
  token: string
  githubAccountId?: string
  /** Host-issued cloud installation authority. Never read from agent-supplied publication input. */
  installationId?: string
  fetcher?: typeof fetch
}

const id = z.number().int().positive().refine(Number.isSafeInteger)
const repoName = /^[a-z0-9_.-]+$/i
const repositorySchema = z.object({ id, full_name: z.string(), default_branch: z.string().min(1) })
const userSchema = z.object({ id, login: z.string().regex(/^[a-z0-9-]+$/i) })
const prSchema = z.object({
  number: id, html_url: z.string(), state: z.enum(['open', 'closed']), draft: z.boolean(),
  title: z.string().max(256).optional(),
  node_id: z.string().min(1).optional(),
  merged_at: z.string().nullable(), body: z.string().nullable(),
  // A single PR carries its line counts; GitHub's list of PRs leaves them out.
  additions: z.number().int().nonnegative().optional(), deletions: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  head: z.object({ ref: z.string(), sha: z.string().regex(/^[a-f0-9]{40,64}$/i).optional(), repo: z.object({ id }).nullable() }),
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

/** The URL and redirects are fixed; no caller can send the person's credential to a git URL. */
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
      // GitHub's status, for server logs: 429 and a limited 403 are rate limits, 5xx is GitHub itself.
      throw new PublicationError('github_unavailable', true, response.status)
    }
    if (response.status === 404 && init.missing) throw new PublicationError(init.missing, init.missing === 'branch_not_pushed', 404)
    // GitHub rejected the person's token: they reconnect GitHub in Mikka.
    if (response.status === 401) throw new PublicationError('github_reconnect_required', false, 401)
    if (response.status === 403 || response.status === 404) throw new PublicationError('github_access_denied', false, response.status)
    if (!response.ok) throw new PublicationError('github_request_failed', false, response.status)
    try { return await response.json() as unknown }
    catch { throw new PublicationError('github_request_failed') }
  }
}

/** The token must be the person's own: GitHub's /user is the linked account. */
async function repositoryAccess(options: Options) {
  const repo = githubRepository(options.remoteKey)
  if (!options.token || !(options.installationId ? /^[1-9][0-9]*$/.test(options.installationId) : /^[1-9][0-9]*$/.test(options.githubAccountId ?? ''))) throw new PublicationError('github_identity_required')
  const request = api(options.fetcher ?? fetch)
  const [credentialIdentity, repository] = await Promise.all([
    options.installationId
      ? request('/installation/repositories?per_page=100', options.token).then(value => parse(z.object({ repositories: z.array(repositorySchema) }), value))
      : request('/user', options.token).then(value => parse(userSchema, value)),
    request(repo.path, options.token, { missing: 'github_access_denied' }).then(value => parse(repositorySchema, value)),
  ])
  if ('repositories' in credentialIdentity) {
    if (!credentialIdentity.repositories.some(item => item.id === repository.id && item.full_name.toLowerCase() === repository.full_name.toLowerCase())) throw new PublicationError('github_access_denied')
  } else if (String(credentialIdentity.id) !== options.githubAccountId) throw new PublicationError('github_reconnect_required')
  if (repository.full_name.toLowerCase() !== `${repo.owner}/${repo.repo}`.toLowerCase()) throw new PublicationError('github_access_denied')
  const binding: GitHubRepositoryBinding = { repositoryId: repository.id, githubAccountId: options.githubAccountId ?? null, defaultBranch: repository.default_branch }
  return { ...repo, request, token: options.token, binding }
}

/**
 * One PR per task branch (ADR 0024). Replays and ambiguous POST responses
 * first find the issue-marked PR; a human's unrelated PR is never adopted.
 * Every request uses the run owner's own GitHub token (decision 2026-11-02-1600).
 */
export async function openRunPullRequest(options: Options & {
  issueId: string; identifier: string; title: string; summary: string
  branch: string; commit: string; baseBranch: string | null
  allowCreate?: boolean
  draft?: boolean
  /** The host holds current task/approval authority for each bounded write. */
  withWrite?: <T>(write: () => Promise<T>) => Promise<T>
  /** Bookkeeping once the repository is read with the owner's token; it must not throw. */
  onVerified?: (binding: GitHubRepositoryBinding) => Promise<void>
}): Promise<PublishedPullRequest> {
  if (!/^mikka\/[a-z0-9-]+-[1-9][0-9]*$/.test(options.branch) || !/^[a-f0-9]{40,64}$/i.test(options.commit) || !z.uuid().safeParse(options.issueId).success) throw new PublicationError('publication_mismatch')
  const access = await repositoryAccess(options)
  const { request, path, binding } = access
  await options.onVerified?.(binding)
  const ref = parse(z.object({ object: z.object({ sha: z.string() }) }), await request(`${path}/git/ref/heads/${options.branch.split('/').map(encodeURIComponent).join('/')}`, access.token, { missing: 'branch_not_pushed' }))
  if (ref.object.sha.toLowerCase() !== options.commit.toLowerCase()) throw new PublicationError('branch_changed')
  const writeToken = access.token
  const marker = `<!-- mikka-issue:${options.issueId} -->`
  const write = <T>(operation: () => Promise<T>) => options.withWrite ? options.withWrite(operation) : operation()
  const verified = (raw: unknown) => {
    const pr = parse(prSchema, raw)
    if (pr.head.ref !== options.branch || pr.head.repo?.id !== binding.repositoryId || pr.base.repo.id !== binding.repositoryId || !pr.body?.trimEnd().endsWith(marker)) throw new PublicationError('pull_request_conflict')
    if (pr.head.sha && pr.head.sha.toLowerCase() !== options.commit.toLowerCase()) throw new PublicationError('branch_changed')
    const expected = `https://github.com/${access.owner}/${access.repo}/pull/${pr.number}`
    if (pr.html_url.toLowerCase() !== expected.toLowerCase()) throw new PublicationError('github_request_failed')
    return pr
  }
  const result = async (pr: ReturnType<typeof verified>, readChecks = true): Promise<PublishedPullRequest> => {
    const lines = pr.additions !== undefined && pr.deletions !== undefined ? { additions: pr.additions, deletions: pr.deletions } : {}
    const review: Partial<PublishedPullRequest> = pr.head.sha ? { branch: pr.head.ref, headSha: pr.head.sha.toLowerCase(),
      ...(pr.changed_files === undefined ? {} : { changedFiles: pr.changed_files }) } : {}
    if (!readChecks) review.reviewChecks = null
    else if (pr.head.sha) {
      try { review.reviewChecks = await readReviewChecks(p => request(p, access.token), path, pr.head.sha) }
      catch (error) {
        // Optional review metadata cannot turn a successfully opened PR into a
        // publication failure. Unknown remains explicit; no green is invented.
        if (!(error instanceof PublicationError)) throw error
        review.reviewChecks = null
      }
    }
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
      return { url: pr.html_url, ...(pr.title ? { title: pr.title } : {}), state: 'draft', ...lines, ...review }
    }
    return { url: pr.html_url, ...(pr.title ? { title: pr.title } : {}), state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open', ...lines, ...review }
  }
  const enriched = async (raw: unknown): Promise<PublishedPullRequest> => {
    // The original POST/list is already a complete authority receipt. Never
    // use optional details to rescue a wrong branch, repository or task marker.
    const original = verified(raw)
    let detail: unknown
    try { detail = await request(`${path}/pulls/${original.number}`, writeToken) }
    catch (error) {
      // One bounded enrichment attempt, not another PR creation/recovery loop.
      // Retain known fields from the verified receipt; omitted counts/checks
      // remain unknown. This fallback cannot swallow contradictory JSON below.
      if (!(error instanceof PublicationError)) throw error
      return result(original, false)
    }
    const resolved = verified(detail)
    if (resolved.number !== original.number || (original.node_id && resolved.node_id && original.node_id !== resolved.node_id)) throw new PublicationError('pull_request_conflict')
    return result(resolved)
  }
  const find = async () => {
    const query = new URLSearchParams({ state: 'all', head: `${access.owner}:${options.branch}`, per_page: '100', sort: 'created', direction: 'desc' })
    const rows = parse(z.array(prSchema), await request(`${path}/pulls?${query}`, writeToken))
    const matching = rows.filter(pr => pr.head.ref === options.branch && pr.head.repo?.id === binding.repositoryId)
    if (!matching.length) return null
    const own = matching.find(pr => pr.body?.trimEnd().endsWith(marker))
    if (!own) throw new PublicationError('pull_request_conflict')
    // A list omits additions/deletions/changed_files. Resolve that one already
    // bound PR during ingestion, never from the inbox/flow read route.
    return enriched(own)
  }
  const existing = await find()
  if (existing) return existing
  if (options.allowCreate === false) throw new PublicationError('pull_request_limit')
  let created: z.infer<typeof prSchema>
  try {
    created = parse(prSchema, await write(() => request(`${path}/pulls`, writeToken, { method: 'POST', body: {
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
  // A successful POST's conflicts, draft mutation and optional enrichment are
  // not ambiguous POST outcomes and must never be retried through find().
  return enriched(created)
}

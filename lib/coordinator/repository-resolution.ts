import { defaultAgentCopy } from '@/lib/agent-copy'
import { isBareRepositoryName, relatedRepositories } from '@/lib/github/repository-match'
import { timedPhase } from '@/lib/dispatch-timing'

type Repository = { fullName: string; private?: boolean; description?: string | null; homepage?: string | null }
/** Lists one user's own authorized repositories. The host passes the user id; a model never does. */
export type RepositoryLister = (userId: string) => Promise<{ repositories: readonly Repository[] }>
type GitHubProblem = 'githubNotConnected' | 'githubNotConfigured' | 'githubReconnectRequired' | 'githubUnavailable' | 'githubRepositoryForbidden'

const ownRepositories: RepositoryLister = async userId => (await import('@/lib/github/user-access')).listRepositoriesForUser(userId)
/** At most this many rows in one BeQuestions choice (lib/agent-ui-catalog.ts). */
const CARD_OPTIONS = 6
const LIST_LIMIT = 50

export function repositoryAmbiguousCard(name: string, candidates: readonly Repository[]) {
  return {
    title: defaultAgentCopy.repositoryAmbiguousTitle.replace('{name}', name),
    options: candidates.slice(0, CARD_OPTIONS).map(repository => ({ value: repository.fullName, label: repository.fullName })),
  }
}

export function repositoryNotFoundCard(name: string) {
  return {
    title: defaultAgentCopy.repositoryNotFoundTitle.replace('{name}', name),
    options: [{ value: 'githubInstall', label: defaultAgentCopy.githubInstallMore, action: 'githubInstall' as const }],
  }
}

async function listFor(userId: string, list: RepositoryLister): Promise<{ repositories: readonly Repository[] } | { error: GitHubProblem }> {
  try { return await list(userId) }
  catch (error) {
    // GitHubAccessError (lib/github/user-access.ts), matched by shape so this stays importable without the auth stack.
    if (error instanceof Error && error.name === 'GitHubAccessError' && 'code' in error && typeof error.code === 'string' && error.code !== 'authRequired') return { error: error.code as GitHubProblem }
    throw error
  }
}

/** One repository a name could mean, with what it says it is, for the Coordinator to judge against the person's words. */
export type RepositoryCandidate = { fullName: string; description: string | null; homepage: string | null; usedByThisWorkspace: boolean }

type Resolution =
  | { repo: string }
  | { error: 'repositoryAmbiguous'; candidates: RepositoryCandidate[]; card: ReturnType<typeof repositoryAmbiguousCard> }
  | { error: 'repositoryNotFound'; card: ReturnType<typeof repositoryNotFoundCard> }
  | { error: GitHubProblem; repository: string }

/**
 * The repositories (owner/repo) the person's threads in this task's workspace already work in. It only
 * orders the candidates and marks them; it never chooses one, and never adds an unauthorized repository.
 */
export type RepositoryContext = { used: readonly string[] }
export type RepositoryContextSource = (userId: string, issueId: string) => Promise<RepositoryContext>

/** Candidates in the order to show them: those this workspace already uses first, else as matched. */
function candidatesOf(repositories: readonly Repository[], context: RepositoryContext | null): RepositoryCandidate[] {
  const used = new Set((context?.used ?? []).map(fullName => fullName.toLowerCase()))
  const listed = repositories.map(repository => ({ fullName: repository.fullName, description: repository.description ?? null, homepage: repository.homepage ?? null, usedByThisWorkspace: used.has(repository.fullName.toLowerCase()) }))
  return [...listed.filter(item => item.usedByThisWorkspace), ...listed.filter(item => !item.usedByThisWorkspace)]
}

/**
 * owner/repo and URLs pass unchanged. A bare name becomes a repository only when it is the one the person could
 * mean; whenever another authorized repository's name contains it too ("Mikka" and mikka-web), nothing is chosen:
 * the candidates come back with their descriptions and homepages for the Coordinator to judge, or to ask with the card.
 */
export async function resolveRepository(userId: string, repo: string, list: RepositoryLister = ownRepositories, context?: () => Promise<RepositoryContext | null>): Promise<Resolution> {
  if (!isBareRepositoryName(repo)) return { repo }
  const name = repo.trim()
  const own = await listFor(userId, list)
  if ('error' in own) return { error: own.error, repository: name }
  const related = relatedRepositories(name, own.repositories)
  if (related.length === 0) return { error: 'repositoryNotFound', card: repositoryNotFoundCard(name) }
  if (related.length === 1) return { repo: related[0]!.fullName }
  const candidates = candidatesOf(related, context ? await context().catch(() => null) : null)
  return { error: 'repositoryAmbiguous', candidates, card: repositoryAmbiguousCard(name, candidates) }
}

const remoteFullName = (remoteUrl: string) => remoteUrl.trim().replace(/^(?:https:\/\/|git@)github\.com[/:]/i, '').replace(/\.git$/i, '').replace(/\/+$/, '')

/** The repositories of the person's threads in this task's team workspace (or, for a personal task, all of theirs). */
const taskContext: RepositoryContextSource = async (userId, issueId) => {
  const [{ pool }, { workspacePool }] = await Promise.all([import('@/lib/db'), import('@/lib/workspace-db')])
  const team = (await workspacePool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$1', [issueId])).rows[0]
  const siblings = team ? (await workspacePool.query<{ issueId: string }>('SELECT "issueId" FROM mikka_team_issues WHERE "workspaceId"=$1', [team.workspaceId])).rows.map(row => row.issueId) : null
  const runs = 'SELECT DISTINCT d."remoteUrl" FROM agent_runs r JOIN device_repos d ON d.id=r."deviceRepoId" WHERE r."userId"=$1 AND d."remoteUrl" IS NOT NULL'
  const { rows } = siblings
    ? await pool.query<{ remoteUrl: string }>(`${runs} AND r."issueId"=ANY($2::uuid[]) LIMIT 200`, [userId, siblings])
    : await pool.query<{ remoteUrl: string }>(`${runs} LIMIT 200`, [userId])
  return { used: rows.map(row => remoteFullName(row.remoteUrl)) }
}

/** Whether `named` (as the person said it, or owner/repo) is the repository at `remoteUrl`; null when the name is not one repository. */
export async function sameRepository(userId: string, named: string, remoteUrl: string, list: RepositoryLister = ownRepositories): Promise<boolean | null> {
  const resolved = await resolveRepository(userId, named, list)
  if (!('repo' in resolved)) return null
  return remoteFullName(resolved.repo).toLowerCase() === remoteFullName(remoteUrl).toLowerCase()
}

/** Dispatches only with a resolved repository; otherwise nothing is queued and the result carries the card. */
export async function withResolvedRepository<T>(userId: string, issueId: string, repo: string, dispatch: (repo: string) => Promise<T>, list: RepositoryLister = ownRepositories, context: RepositoryContextSource = taskContext) {
  const resolved = await timedPhase('resolveRepository', () => resolveRepository(userId, repo, list, () => context(userId, issueId)))
  return 'repo' in resolved ? dispatch(resolved.repo) : { ...resolved, issueId }
}

/**
 * find_repository: the user's own authorized repositories matching a name, with what each says it is, or the first
 * ones when no name is given. One match only when no other repository's name contains the name too.
 */
export async function findRepository(userId: string, name: string | undefined, list: RepositoryLister = ownRepositories) {
  const own = await listFor(userId, list)
  if ('error' in own) return own
  const wanted = name?.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '') ?? ''
  const about = (repository: Repository) => ({ description: repository.description ?? null, homepage: repository.homepage ?? null })
  if (!wanted) return { total: own.repositories.length, repositories: own.repositories.slice(0, LIST_LIMIT).map(repository => ({ fullName: repository.fullName, ...about(repository) })) }
  if (wanted.includes('/')) {
    const exact = own.repositories.find(repository => repository.fullName.toLowerCase() === wanted.toLowerCase())
    return exact ? { match: 'one' as const, repository: exact.fullName, ...about(exact) } : { match: 'none' as const, card: repositoryNotFoundCard(wanted) }
  }
  const related = relatedRepositories(wanted, own.repositories)
  if (related.length === 1) return { match: 'one' as const, repository: related[0]!.fullName, ...about(related[0]!) }
  if (related.length === 0) return { match: 'none' as const, card: repositoryNotFoundCard(wanted) }
  const candidates = candidatesOf(related, null)
  return { match: 'several' as const, candidates, card: repositoryAmbiguousCard(wanted, candidates) }
}

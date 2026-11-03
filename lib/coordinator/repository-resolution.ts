import { defaultAgentCopy } from '@/lib/agent-copy'
import { isBareRepositoryName, matchRepositoryName, matchRepositoryWords, type RepositoryMatch } from '@/lib/github/repository-match'
import { timedPhase } from '@/lib/dispatch-timing'

type Repository = { fullName: string; private?: boolean }
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

type Resolution =
  | { repo: string }
  | { error: 'repositoryAmbiguous'; card: ReturnType<typeof repositoryAmbiguousCard> }
  | { error: 'repositoryNotFound'; card: ReturnType<typeof repositoryNotFoundCard> }
  | { error: GitHubProblem; repository: string }

/**
 * What the task itself says about its repository: the issue's own text, and the repositories
 * (owner/repo) the threads of its workspace already work in. Read only to choose among names
 * that match; it never adds a repository the person did not authorize.
 */
export type RepositoryContext = { text: string; used: readonly string[] }
export type RepositoryContextSource = (userId: string, issueId: string) => Promise<RepositoryContext>

/** A name's exact or loose match, else its family-and-qualifier match ("Mikka site" → mikka-web). */
function matchName<T extends Repository>(name: string, repositories: readonly T[]): RepositoryMatch<T> {
  const match = matchRepositoryName(name, repositories)
  return match.kind === 'none' ? matchRepositoryWords(name, repositories) : match
}

/** Among several matches, the one the task names, else the one its workspace's threads already use; else none. */
function chooseByContext<T extends Repository>(candidates: readonly T[], context: RepositoryContext | null): T | null {
  if (!context) return null
  // owner/repo as a whole name: alexj11324/Mikka is not named by alexj11324/mikka-web.
  const names = (fullName: string) => new RegExp(`(?<![\\w.-])${fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)`, 'i').test(context.text)
  const named = candidates.filter(repository => names(repository.fullName))
  if (named.length === 1) return named[0]!
  const used = new Set(context.used.map(fullName => fullName.toLowerCase()))
  const known = candidates.filter(repository => used.has(repository.fullName.toLowerCase()))
  return known.length === 1 ? known[0]! : null
}

/** owner/repo and URLs pass unchanged; a bare name becomes the one matching repository the user authorized, or a card. */
export async function resolveRepository(userId: string, repo: string, list: RepositoryLister = ownRepositories, context?: () => Promise<RepositoryContext | null>): Promise<Resolution> {
  if (!isBareRepositoryName(repo)) return { repo }
  const name = repo.trim()
  const own = await listFor(userId, list)
  if ('error' in own) return { error: own.error, repository: name }
  const match = matchName(name, own.repositories)
  if (match.kind === 'one') return { repo: match.repository.fullName }
  if (match.kind === 'none') return { error: 'repositoryNotFound', card: repositoryNotFoundCard(name) }
  // Several fit the name: the task's own context may settle it; if not, the person is asked, never guessed for.
  const chosen = chooseByContext(match.candidates, context ? await context().catch(() => null) : null)
  return chosen ? { repo: chosen.fullName } : { error: 'repositoryAmbiguous', card: repositoryAmbiguousCard(name, match.candidates) }
}

const remoteFullName = (remoteUrl: string) => remoteUrl.trim().replace(/^(?:https:\/\/|git@)github\.com[/:]/i, '').replace(/\.git$/i, '').replace(/\/+$/, '')

/** The issue's text, and the repositories of the person's threads in its team workspace (or, for a personal task, all of theirs). */
const taskContext: RepositoryContextSource = async (userId, issueId) => {
  const [{ pool }, { workspacePool }, { tiptapToText }] = await Promise.all([import('@/lib/db'), import('@/lib/workspace-db'), import('@/lib/tiptap-text')])
  const issue = (await pool.query<{ title: string; content: unknown }>('SELECT title,content FROM issues WHERE id=$1', [issueId])).rows[0]
  const team = (await workspacePool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$1', [issueId])).rows[0]
  const siblings = team ? (await workspacePool.query<{ issueId: string }>('SELECT "issueId" FROM mikka_team_issues WHERE "workspaceId"=$1', [team.workspaceId])).rows.map(row => row.issueId) : null
  const runs = 'SELECT DISTINCT d."remoteUrl" FROM agent_runs r JOIN device_repos d ON d.id=r."deviceRepoId" WHERE r."userId"=$1 AND d."remoteUrl" IS NOT NULL'
  const { rows } = siblings
    ? await pool.query<{ remoteUrl: string }>(`${runs} AND r."issueId"=ANY($2::uuid[]) LIMIT 200`, [userId, siblings])
    : await pool.query<{ remoteUrl: string }>(`${runs} LIMIT 200`, [userId])
  return { text: issue ? `${issue.title}\n${tiptapToText(issue.content as never)}` : '', used: rows.map(row => remoteFullName(row.remoteUrl)) }
}

/** Dispatches only with a resolved repository; otherwise nothing is queued and the result carries the card. */
export async function withResolvedRepository<T>(userId: string, issueId: string, repo: string, dispatch: (repo: string) => Promise<T>, list: RepositoryLister = ownRepositories, context: RepositoryContextSource = taskContext) {
  const resolved = await timedPhase('resolveRepository', () => resolveRepository(userId, repo, list, () => context(userId, issueId)))
  return 'repo' in resolved ? dispatch(resolved.repo) : { ...resolved, issueId }
}

/** find_repository: the user's own authorized repositories matching a name, or the first ones when no name is given. */
export async function findRepository(userId: string, name: string | undefined, list: RepositoryLister = ownRepositories) {
  const own = await listFor(userId, list)
  if ('error' in own) return own
  const wanted = name?.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '') ?? ''
  if (!wanted) return { total: own.repositories.length, repositories: own.repositories.slice(0, LIST_LIMIT).map(repository => repository.fullName) }
  if (wanted.includes('/')) {
    const exact = own.repositories.find(repository => repository.fullName.toLowerCase() === wanted.toLowerCase())
    return exact ? { match: 'one' as const, repository: exact.fullName } : { match: 'none' as const, card: repositoryNotFoundCard(wanted) }
  }
  const match = matchName(wanted, own.repositories)
  if (match.kind === 'one') return { match: 'one' as const, repository: match.repository.fullName }
  return match.kind === 'several'
    ? { match: 'several' as const, candidates: match.candidates.map(repository => repository.fullName), card: repositoryAmbiguousCard(wanted, match.candidates) }
    : { match: 'none' as const, card: repositoryNotFoundCard(wanted) }
}

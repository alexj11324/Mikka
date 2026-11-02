import { defaultAgentCopy } from '@/lib/agent-copy'
import { isBareRepositoryName, matchRepositoryName } from '@/lib/github/repository-match'
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

/** owner/repo and URLs pass unchanged; a bare name becomes the one matching repository the user authorized, or a card. */
export async function resolveRepository(userId: string, repo: string, list: RepositoryLister = ownRepositories): Promise<Resolution> {
  if (!isBareRepositoryName(repo)) return { repo }
  const name = repo.trim()
  const own = await listFor(userId, list)
  if ('error' in own) return { error: own.error, repository: name }
  const match = matchRepositoryName(name, own.repositories)
  if (match.kind === 'one') return { repo: match.repository.fullName }
  return match.kind === 'several'
    ? { error: 'repositoryAmbiguous', card: repositoryAmbiguousCard(name, match.candidates) }
    : { error: 'repositoryNotFound', card: repositoryNotFoundCard(name) }
}

/** Dispatches only with a resolved repository; otherwise nothing is queued and the result carries the card. */
export async function withResolvedRepository<T>(userId: string, issueId: string, repo: string, dispatch: (repo: string) => Promise<T>, list: RepositoryLister = ownRepositories) {
  const resolved = await timedPhase('resolveRepository', () => resolveRepository(userId, repo, list))
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
  const match = matchRepositoryName(wanted, own.repositories)
  if (match.kind === 'one') return { match: 'one' as const, repository: match.repository.fullName }
  return match.kind === 'several'
    ? { match: 'several' as const, candidates: match.candidates.map(repository => repository.fullName), card: repositoryAmbiguousCard(wanted, match.candidates) }
    : { match: 'none' as const, card: repositoryNotFoundCard(wanted) }
}

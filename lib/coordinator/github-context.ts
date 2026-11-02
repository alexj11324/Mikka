/** What the Bot knows about the person's own GitHub each turn, so it never asks which account a repository is under. */
export type GitHubContextSource = {
  connection: (userId: string) => Promise<{ githubLogin: string } | null>
  list: (userId: string) => Promise<{ login: string | null; installationAccounts: readonly string[]; repositories: readonly unknown[] }>
}

const source: GitHubContextSource = {
  connection: async userId => (await import('@/lib/github/connection')).githubConnection(userId),
  list: async userId => (await import('@/lib/github/user-access')).listRepositoriesForUser(userId),
}
/** A slow GitHub never holds up the turn: past this the repository count is left out. */
const LIST_TIMEOUT_MS = 4_000

const failureCode = (error: unknown) => error instanceof Error && error.name === 'GitHubAccessError' && 'code' in error ? String(error.code) : null

export async function githubContext(userId: string, from: GitHubContextSource = source, timeoutMs = LIST_TIMEOUT_MS): Promise<string> {
  const connection = await from.connection(userId).catch(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const listed = await Promise.race([
    from.list(userId).then(value => ({ value }), (error: unknown) => ({ failure: failureCode(error) })),
    new Promise<{ failure: null }>(resolve => { timer = setTimeout(() => resolve({ failure: null }), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
  if (!connection && 'failure' in listed && listed.failure === 'githubNotConnected') return 'GitHub: not connected. The person connects it in 插件 › GitHub; until then a repository is given as an HTTPS or SSH git URL.'
  const login = connection?.githubLogin ?? ('value' in listed ? listed.value.login : null)
  // With no connection row and no answer from GitHub, nothing about the account is claimed.
  const lines = login ? [`GitHub: the person's connected GitHub account is @${login}.`] : connection || 'value' in listed ? ['GitHub: the person has a GitHub account connected.'] : []
  if ('value' in listed) {
    const { installationAccounts, repositories } = listed.value
    lines.push(installationAccounts.length
      ? `The Mikka GitHub App is installed on ${[...new Set(installationAccounts)].map(account => `@${account}`).join(', ')} and reaches ${repositories.length} repositories.`
      : 'The Mikka GitHub App is not installed on any account yet; the person installs it from 插件 › GitHub.')
  }
  lines.push('Never ask which account or owner a repository is under: look it up with find_repository, or pass the name the person used to dispatch_run.')
  return lines.join('\n')
}

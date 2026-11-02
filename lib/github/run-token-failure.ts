import { GitHubAccessError } from './user-access-error'

/**
 * Why a run could not get its owner's GitHub credential, as far as the server
 * can tell without reading it: the code the daemon receives and its HTTP
 * status. Nothing here comes from a GitHub response body, a token or a header.
 */
export const RUN_GITHUB_ERROR_CODES = ['githubNotConnected', 'githubReconnectRequired', 'runGitHubUnavailable'] as const
export type RunGitHubErrorCode = typeof RUN_GITHUB_ERROR_CODES[number]
export type RunGitHubFailure = { code: RunGitHubErrorCode; status: number; retryable: boolean }

export function classifyRunGitHubFailure(error: unknown): RunGitHubFailure {
  if (!(error instanceof GitHubAccessError)) return { code: 'runGitHubUnavailable', status: 502, retryable: true }
  if (error.code === 'githubNotConnected') return { code: 'githubNotConnected', status: 409, retryable: false }
  if (error.code === 'githubUnavailable') return { code: 'runGitHubUnavailable', status: 502, retryable: true }
  return { code: 'githubReconnectRequired', status: 409, retryable: false }
}

/** One structured line per failure: the code only. */
export function logRunGitHubFailure(failure: RunGitHubFailure, context: { runId: string | null; stage: 'authorize' | 'issue' | 'reauthorize' }, log: (line: string) => void = line => console.error(line)) {
  log(JSON.stringify({ event: 'run_github_token_failed', runId: context.runId, stage: context.stage, code: failure.code, retryable: failure.retryable }))
}

import { PublicationError } from '@/lib/run-publication-result'

/**
 * Why a run's GitHub token could not be issued, as far as the server can tell
 * without reading any credential: the category, GitHub's HTTP status when it
 * answered, and the error code the daemon receives. Nothing here comes from a
 * GitHub response body, a token, the App key or a request header.
 */
export type RunGitHubFailure = {
  category:
    | 'app_not_configured' | 'app_credentials_rejected' | 'identity_required' | 'app_not_installed' | 'app_suspended'
    | 'app_permission_missing' | 'account_no_write_access' | 'repository_not_github' | 'rate_limited'
    | 'github_server_error' | 'github_unreachable' | 'github_request_failed' | 'unexpected'
  /** GitHub's HTTP status when GitHub answered; absent when it never did. */
  githubStatus: number | null
  /** Whether the installation exists: false only when GitHub said it does not. */
  installation: 'missing' | 'present' | 'unknown'
  retryable: boolean
  /** The code returned to the daemon. */
  code: RunGitHubErrorCode
  status: number
}

export const RUN_GITHUB_ERROR_CODES = [
  'githubAppNotConfigured', 'githubIdentityRequired', 'githubAppNotInstalled', 'githubAppSuspended',
  'githubAppPermissionRequired', 'githubAccountNoWriteAccess', 'githubRepositoryNotSupported', 'githubRateLimited', 'runGitHubUnavailable',
] as const
export type RunGitHubErrorCode = typeof RUN_GITHUB_ERROR_CODES[number]

export function classifyRunGitHubFailure(error: unknown): RunGitHubFailure {
  if (!(error instanceof PublicationError)) return { category: 'unexpected', githubStatus: null, installation: 'unknown', retryable: true, code: 'runGitHubUnavailable', status: 502 }
  const githubStatus = error.status ?? null
  const base = { githubStatus, installation: 'present' as const, retryable: error.retryable }
  switch (error.code) {
    case 'github_not_configured':
      // GitHub rejected this server's App JWT or the token it just minted: the App ID, key or clock is wrong here.
      return githubStatus === 401
        ? { ...base, installation: 'unknown', category: 'app_credentials_rejected', code: 'githubAppNotConfigured', status: 503 }
        : { ...base, installation: 'unknown', category: 'app_not_configured', code: 'githubAppNotConfigured', status: 503 }
    case 'github_identity_required': return { ...base, installation: 'unknown', category: 'identity_required', code: 'githubIdentityRequired', status: 409 }
    case 'github_not_installed': return { ...base, installation: 'missing', category: 'app_not_installed', code: 'githubAppNotInstalled', status: 409 }
    case 'github_suspended': return { ...base, category: 'app_suspended', code: 'githubAppSuspended', status: 409 }
    case 'github_permission_required': return { ...base, category: 'app_permission_missing', code: 'githubAppPermissionRequired', status: 409 }
    case 'github_access_denied': return { ...base, category: 'account_no_write_access', code: 'githubAccountNoWriteAccess', status: 409 }
    case 'repository_not_github': return { ...base, installation: 'unknown', category: 'repository_not_github', code: 'githubRepositoryNotSupported', status: 409 }
    case 'github_unavailable':
      if (githubStatus === 429 || githubStatus === 403) return { ...base, installation: 'unknown', category: 'rate_limited', code: 'githubRateLimited', status: 503 }
      if (githubStatus !== null) return { ...base, installation: 'unknown', category: 'github_server_error', code: 'runGitHubUnavailable', status: 502 }
      return { ...base, installation: 'unknown', category: 'github_unreachable', code: 'runGitHubUnavailable', status: 502 }
    default: return { ...base, installation: 'unknown', category: 'github_request_failed', code: 'runGitHubUnavailable', status: 502 }
  }
}

/** One structured line per failure: the category and status only. */
export function logRunGitHubFailure(failure: RunGitHubFailure, context: { runId: string | null; stage: 'authorize' | 'issue' | 'reauthorize' }, log: (line: string) => void = line => console.error(line)) {
  log(JSON.stringify({
    event: 'run_github_token_failed', runId: context.runId, stage: context.stage,
    category: failure.category, githubStatus: failure.githubStatus, installation: failure.installation, retryable: failure.retryable, code: failure.code,
  }))
}

import { withDeviceRoute } from '@/lib/device-route'
import { authorizeDesktopGitHubToken, authorizeDeviceRunGitHubToken } from '@/lib/github/desktop-token-authority'
import { createRunGitHubTokenExchange, RUN_GITHUB_MIN_VALIDITY_MS } from '@/lib/github/run-token-exchange'
import { githubTokenForUser } from '@/lib/github/user-access'

export const dynamic = 'force-dynamic'

/** `POST /v1/devices/:deviceId/github-token`: a Bot desktop's git and gh get its owner's own GitHub credential (decision 2026-11-02-1600). */
async function handlePOST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { deviceId } = await params
  const runId = new URL(request.url).searchParams.get('runId')
  return createRunGitHubTokenExchange({
    authorize: value => runId === null ? authorizeDesktopGitHubToken(value, deviceId) : authorizeDeviceRunGitHubToken(value, deviceId, runId),
    issue: userId => githubTokenForUser(userId, { minValidityMs: RUN_GITHUB_MIN_VALIDITY_MS }),
    naturalExpiry: runId !== null,
  })(request)
}

export const POST = withDeviceRoute(handlePOST)

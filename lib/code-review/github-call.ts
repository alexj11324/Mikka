import 'server-only'
import { GitHubMcpPolicyError, type GitHubMcpCommand, type GitHubMcpGuard } from '@/lib/github/mcp'
import { githubCallDecision } from '@/lib/operations/github-call-policy'
import { ScheduleError } from '@/lib/schedules/contract'
import { WorkspaceError } from '@/lib/workspace-access'
import { withReviewRequestAuthority } from './request-authority'
import { reviewGitHubCallAllowed } from './github-policy'

/** Wrap the existing GitHub MCP call with the originating review's current
 * authority; this never replaces the workspace deny or the caller's identity. */
export async function reviewGitHubCall<T>(userId: string, context: { botId: string; sourceEventId: string },
  command: GitHubMcpCommand, execute: (guard?: GitHubMcpGuard) => Promise<T>): Promise<T | { error: string }> {
  try {
    return await withReviewRequestAuthority(userId, context.sourceEventId, context.botId, async authority => {
      if (!authority || !('name' in command)) return execute()
      const policy = await githubCallDecision(userId, context.botId)
      if (policy !== 'allow') throw new GitHubMcpPolicyError(policy === 'deny' ? 'githubActionDenied' : 'githubPolicyUnavailable')
      return execute(async (call, readOnly) => reviewGitHubCallAllowed(authority, call, readOnly))
    })
  } catch (error) {
    if (error instanceof GitHubMcpPolicyError) return { error: error.code }
    if (error instanceof ScheduleError || error instanceof WorkspaceError) return { error: 'githubActionDenied' }
    throw error
  }
}

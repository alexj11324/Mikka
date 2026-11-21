import type { GitHubMcpCommand } from '@/lib/github/mcp'

export type ReviewGitHubAuthority = { repository: string; pullNumber: number; output: 'comments' | 'summary' }

/** The official MCP catalogue supplies readOnlyHint. A managed review can
 * narrow that native capability, never grant approval, merge or general writes. */
export function reviewGitHubCallAllowed(authority: ReviewGitHubAuthority, command: Extract<GitHubMcpCommand, { name: string }>, readOnly: boolean): boolean {
  if (readOnly) return true
  if (authority.output !== 'comments') return false
  const args = command.arguments
  if (typeof args.owner !== 'string' || typeof args.repo !== 'string'
    || `v2/github.com/${args.owner}/${args.repo}`.toLowerCase() !== authority.repository
    || args.pullNumber !== authority.pullNumber) return false
  if (command.name === 'add_comment_to_pending_review') return true
  if (command.name !== 'pull_request_review_write') return false
  // Creating a pending review omits event. Submitting may only COMMENT;
  // even a differently cased APPROVE/REQUEST_CHANGES is not accepted.
  return args.method === 'create' && (args.event === undefined || args.event === 'COMMENT')
    || args.method === 'submit_pending' && args.event === 'COMMENT'
}

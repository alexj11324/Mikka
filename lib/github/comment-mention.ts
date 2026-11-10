/**
 * M3's GitHub comment mention predicate: one import-free, pure decision for
 * `issue_comment` and `pull_request_review_comment` deliveries. The webhook
 * route can drop every other delivery before it loads the database.
 *
 * It answers only "is this a mention on a pull request, and what identifies
 * it": the caller resolves the publication, stores the event and posts the
 * reply. The comment body is never returned or stored here.
 *
 * Mention names: `@mikka` always, plus the configured App slug the caller
 * passes from `githubAppSlug()` (cloud: `mikka-github`; self-hosted:
 * `GITHUB_APP_SLUG`). No import keeps this usable in the webhook's early path.
 */

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
const MAX_BODY_BYTES = 64 * 1024
const encoder = new TextEncoder()

export type CommentMentionKind = 'issue_comment' | 'pull_request_review_comment'

export type CommentMention = {
  kind: CommentMentionKind
  /** `owner/repo`, as GitHub reports it. */
  repo: string
  pullNumber: number
  commentId: number
  author: string
  /** The comment's own permalink; never the body. */
  commentUrl: string
}

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** `@mikka` plus the configured App slug, at a word boundary and case-insensitively. */
export function commentMentionPattern(appSlug?: string | null): RegExp {
  const names = ['mikka', ...(appSlug ? [appSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')] : [])]
  return new RegExp(`(^|[^\\w])@(?:${names.join('|')})(?![\\w-])`, 'i')
}

/** GitHub marks an App's own comments with `type: 'Bot'` and a `[bot]` login.
 * Both `sender` and the comment author are checked so our reply cannot loop. */
function botAuthored(sender: JsonObject | null, user: JsonObject | null, appSlug?: string | null): boolean {
  if (sender?.type === 'Bot' || user?.type === 'Bot') return true
  const slug = appSlug?.toLowerCase() ?? null
  for (const login of [sender?.login, user?.login]) {
    if (typeof login !== 'string') continue
    const normalized = login.toLowerCase()
    if (normalized.endsWith('[bot]') || (slug !== null && normalized === `${slug}[bot]`)) return true
  }
  return false
}

function repositoryOf(payload: JsonObject): { repo: string; archived: boolean } | null {
  const repository = object(payload.repository)
  if (!repository || typeof repository.full_name !== 'string' || !REPOSITORY.test(repository.full_name)) return null
  return { repo: repository.full_name, archived: repository.archived === true }
}

function commentUrl(kind: CommentMentionKind, repo: string, pullNumber: number, commentId: number): string {
  return kind === 'issue_comment'
    ? `https://github.com/${repo}/pull/${pullNumber}#issuecomment-${commentId}`
    : `https://github.com/${repo}/pull/${pullNumber}#discussion_r${commentId}`
}

/** The mention's identities, or null when this delivery must be ignored. */
export function commentMentionEvent(
  event: string | null,
  payload: unknown,
  options: { appSlug?: string | null } = {},
): CommentMention | null {
  if (event !== 'issue_comment' && event !== 'pull_request_review_comment') return null
  const root = object(payload)
  if (!root || root.action !== 'created') return null
  const repository = repositoryOf(root)
  if (!repository || repository.archived) return null
  const comment = object(root.comment)
  if (!comment || typeof comment.body !== 'string' || !positiveSafeInteger(comment.id)) return null
  // Reject prefixes cheaply first: UTF-8 bytes are never fewer than UTF-16 units.
  if (comment.body.length > MAX_BODY_BYTES || encoder.encode(comment.body).byteLength > MAX_BODY_BYTES) return null
  const user = object(comment.user)
  if (botAuthored(object(root.sender), user, options.appSlug)) return null
  if (!user || typeof user.login !== 'string' || user.login.length === 0) return null
  if (!commentMentionPattern(options.appSlug).test(comment.body)) return null

  let pullNumber: number
  if (event === 'issue_comment') {
    const issue = object(root.issue)
    if (!issue || !object(issue.pull_request) || !positiveSafeInteger(issue.number)) return null
    pullNumber = issue.number
  } else {
    const pullRequest = object(root.pull_request)
    if (!pullRequest || !positiveSafeInteger(pullRequest.number)) return null
    pullNumber = pullRequest.number
  }

  return {
    kind: event,
    repo: repository.repo,
    pullNumber,
    commentId: comment.id,
    author: user.login,
    commentUrl: commentUrl(event, repository.repo, pullNumber, comment.id),
  }
}

import 'server-only'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { remainingRequestBudget, requestBudgetSignal, type RequestBudget } from '../../request-budget'

/** One request's fixed-origin, bounded GitHub reads. Pagination links are
 * inspected only for continuation; their URLs are never followed. */
export class GitHubDiffClient {
  private requests = 0
  private bytes = 0
  constructor(private token: string, readonly budget: RequestBudget) {}

  async get(path: string, limit = 4 * 1024 * 1024): Promise<{ value: unknown; next: boolean }> {
    if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/.test(path) || path.split(/[/?]/).some(part => part === '.' || part === '..')
      || path.includes('%') || path.includes('#') || path.includes('\\') || ++this.requests > 48) throw new CodingWorkspaceError('workspace_limit_exceeded')
    try { remainingRequestBudget(this.budget) } catch { throw new WorkspaceReviewError('workspace_review_github_unavailable') }
    let response: Response
    try {
      response = await fetch(`https://api.github.com${path}`, { redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' }, signal: requestBudgetSignal(this.budget, 15_000) })
    } catch { throw new WorkspaceReviewError('workspace_review_github_unavailable') }
    const reader = response.body?.getReader()
    if (!reader) throw new WorkspaceReviewError('workspace_review_github_unavailable')
    let value: unknown
    try {
      const chunks: Uint8Array[] = []; let bytes = 0
      while (true) {
        remainingRequestBudget(this.budget)
        const part = await reader.read(); if (part.done) break
        bytes += part.value.byteLength; this.bytes += part.value.byteLength
        if (bytes > (response.ok ? limit : 64 * 1024) || this.bytes > 32 * 1024 * 1024)
          throw new CodingWorkspaceError('workspace_limit_exceeded')
        chunks.push(part.value)
      }
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch (error) { if (response.ok) throw error; value = null }
    } catch (error) {
      await reader.cancel().catch(() => {})
      if (error instanceof CodingWorkspaceError) throw error
      throw new WorkspaceReviewError('workspace_review_github_unavailable')
    } finally { reader.releaseLock() }
    if (!response.ok) {
      const message = value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : ''
      if (response.status === 429 || response.status >= 500 || response.headers.has('retry-after')
        || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /rate.limit|abuse.detection/i.test(message))))
        throw new WorkspaceReviewError('workspace_review_github_unavailable')
      if ([401, 403, 404].includes(response.status)) throw new WorkspaceReviewError('workspace_review_github_forbidden')
      if (response.status === 409) throw new WorkspaceReviewError('workspace_snapshot_outdated')
      throw new WorkspaceReviewError('workspace_review_github_unavailable')
    }
    return { value, next: /rel="next"/.test(response.headers.get('link') ?? '') }
  }
}

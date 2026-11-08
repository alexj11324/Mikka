import 'server-only'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { remainingRequestBudget, requestBudgetSignal, type RequestBudget } from '../../request-budget'

/** An explicit non-rate-limit 4xx from the mutation endpoint proves this
 * invocation was refused. A later receipt/readback failure never gets this tag. */
export class GitHubWriteRejection extends WorkspaceReviewError {}

/** One request's fixed-origin, bounded GitHub reads. Pagination links are
 * inspected only for continuation; their URLs are never followed. */
export class GitHubDiffClient {
  private requests = 0
  private bytes = 0
  constructor(private token: string, readonly budget: RequestBudget) {}

  async get(path: string, limit = 4 * 1024 * 1024): Promise<{ value: unknown; next: boolean }> {
    return this.request(path, 'GET', undefined, limit)
  }

  /** Only server-owned read documents use this entry point. Partial GraphQL
   * data is never evidence when any field failed authorization or resolution. */
  async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    if (!/^query\b/.test(query.trim()) || /\bmutation\b/.test(query)) throw new CodingWorkspaceError('workspace_invalid_request')
    const { value } = await this.request('/graphql', 'POST', { query, variables }, 4 * 1024 * 1024)
    if (!value || typeof value !== 'object') throw new WorkspaceReviewError('workspace_review_github_unavailable')
    if ('errors' in value && (!Array.isArray(value.errors) || value.errors.length > 0)) {
      const forbidden = Array.isArray(value.errors) && value.errors.some(error => error && typeof error === 'object'
        && 'type' in error && ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'].includes(String(error.type)))
      throw new WorkspaceReviewError(forbidden ? 'workspace_review_github_forbidden' : 'workspace_review_github_unavailable')
    }
    if (!('data' in value) || !value.data) throw new WorkspaceReviewError('workspace_review_github_unavailable')
    return value.data
  }

  /** Call only behind the durable operation invocation gate. No transport
   * retries: a failed response may still represent an accepted provider write. */
  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9]\d*\/(?:reviews|comments\/[1-9]\d*\/replies)$/.test(path))
      throw new CodingWorkspaceError('workspace_invalid_request')
    return (await this.request(path, 'POST', body, 1024 * 1024)).value
  }

  private async request(path: string, method: 'GET' | 'POST', payload: Record<string, unknown> | undefined,
    limit: number): Promise<{ value: unknown; next: boolean }> {
    const graphql = path === '/graphql' && method === 'POST'
    if ((!graphql && (!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/|$)/.test(path)
      || path.split(/[/?]/).some(part => part === '.' || part === '..') || path.includes('%') || path.includes('#') || path.includes('\\')))
      || ++this.requests > 48) throw new CodingWorkspaceError('workspace_limit_exceeded')
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    if (body && Buffer.byteLength(body) > 128 * 1024) throw new CodingWorkspaceError('workspace_limit_exceeded')
    try { remainingRequestBudget(this.budget) } catch (cause) { throw new WorkspaceReviewError('workspace_review_github_unavailable', { cause }) }
    let response: Response
    try {
      response = await fetch(`https://api.github.com${path}`, { method, ...(method === 'POST' ? { body } : {}), redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          'x-github-api-version': '2022-11-28', 'user-agent': 'Mikka' }, signal: requestBudgetSignal(this.budget, 15_000) })
    // error-cause: transport errors may retain the bearer Authorization header.
    } catch { throw new WorkspaceReviewError('workspace_review_github_unavailable') }
    // A mutation's explicit validation refusal is already conclusive. Losing
    // its error body must not turn a refused write into an uncertain delivery.
    if (method === 'POST' && !graphql && response.status === 422 && !response.headers.has('retry-after')
      && response.headers.get('x-ratelimit-remaining') !== '0') {
      await response.body?.cancel().catch(() => {})
      throw new GitHubWriteRejection('workspace_review_github_unavailable')
    }
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
      // error-cause: JSON and stream errors can quote private source or review bodies.
      throw new WorkspaceReviewError('workspace_review_github_unavailable')
    } finally { reader.releaseLock() }
    if (!response.ok) {
      const message = value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' ? value.message : ''
      if (response.status === 429 || response.status >= 500 || response.headers.has('retry-after')
        || ([403, 422].includes(response.status) && response.headers.get('x-ratelimit-remaining') === '0')
        || (response.status === 403 && /rate.limit|abuse.detection/i.test(message)))
        throw new WorkspaceReviewError('workspace_review_github_unavailable')
      if (method === 'POST' && !graphql && response.status >= 400 && response.status < 500)
        throw new GitHubWriteRejection([401, 403, 404].includes(response.status) ? 'workspace_review_github_forbidden'
          : response.status === 409 ? 'workspace_snapshot_outdated' : 'workspace_review_github_unavailable')
      if ([401, 403, 404].includes(response.status)) throw new WorkspaceReviewError('workspace_review_github_forbidden')
      if (response.status === 409) throw new WorkspaceReviewError('workspace_snapshot_outdated')
      throw new WorkspaceReviewError('workspace_review_github_unavailable')
    }
    return { value, next: /rel="next"/.test(response.headers.get('link') ?? '') }
  }
}

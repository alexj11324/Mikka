/** Expected read failures are terminal until the person acts or an explicit
 * live/reconnect read occurs. Keep the server's exact code for UI copy and
 * expose the access status to the cache's revocation policy. */
export class CacheReadError extends Error {
  readonly retryable = false
  readonly status: number
  constructor(readonly code: string) {
    super(code)
    this.name = 'CacheReadError'
    this.status = code === 'authRequired' ? 401
      : code === 'workspaceAccessDenied' || code === 'workspaceMembershipSuspended' ? 403
      : code === 'issueNotFound' || code === 'botNotFound' ? 404 : 400
  }
}

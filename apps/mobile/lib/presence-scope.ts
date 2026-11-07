import { apiCache, type ApiCache } from './api-cache'
import { LIVE_ID } from '../../../lib/live/events'
import type { HomeScopeProof } from '../../../lib/live/home-scope-proof'

type RequestScope = { accountId: string | null; ownerId: string | null; context: number; generation: number }

/** In-memory routing metadata only. A selected team never replaces this home;
 * the server verifies the signature and fresh owned devices on every read. */
export class PresenceScopeCache {
  private held: HomeScopeProof | null = null
  private heldAccount: string | null = null
  private generation = 0
  constructor(private cache: ApiCache = apiCache, private now: () => number = Date.now) {}
  begin(): RequestScope { return { accountId: this.cache.account(), ownerId: this.cache.owner(), context: this.cache.context(), generation: this.generation } }

  remember(workspaceId: string, value: unknown, request: RequestScope) {
    if (!request.accountId || !request.ownerId || request.generation !== this.generation || request.accountId !== this.cache.account() || request.ownerId !== this.cache.owner() || request.context !== this.cache.context()) return
    const ticket = value && typeof value === 'object' ? value as { homeScope?: unknown; expiresAt?: unknown } : null
    const proof = ticket?.homeScope && typeof ticket.homeScope === 'object' && !Array.isArray(ticket.homeScope) ? ticket.homeScope as Partial<HomeScopeProof> : null
    const now = this.now()
    if (proof && Object.keys(proof).length === 4 && proof.ownerId === request.ownerId && proof.workspaceId === workspaceId && LIVE_ID.test(workspaceId)
      && typeof proof.expiresAt === 'number' && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > now && proof.expiresAt <= now + 305_000
      && typeof ticket?.expiresAt === 'number' && proof.expiresAt <= ticket.expiresAt
      && typeof proof.token === 'string' && proof.token.length <= 1024 && /^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(proof.token)) {
      this.held = { ownerId: request.ownerId, workspaceId, expiresAt: proof.expiresAt, token: proof.token }
      this.heldAccount = request.accountId
    } else if (this.held?.workspaceId === workspaceId) this.held = null
  }

  token(context = this.cache.context()): string | null {
    if (context !== this.cache.context()) return null
    if (!this.held || this.heldAccount !== this.cache.account() || this.held.ownerId !== this.cache.owner() || this.held.expiresAt <= this.now()) { this.held = null; this.heldAccount = null; return null }
    return this.held.token
  }
  clear() { this.held = null; this.heldAccount = null; this.generation++ }
}

export const presenceScope = new PresenceScopeCache()

import { isLinearOAuthRevocation } from './webhook'

type OAuthEvent = {
  action?: unknown
  type?: unknown
  organizationId?: unknown
  data?: Record<string, unknown>
}

type RevocationStore = {
  revokeAuthorization(organizationId: string, linearUserId: string): Promise<void>
  revokeOrganization(organizationId: string): Promise<void>
}

export function createLinearOAuthRevocationProcessor(store: RevocationStore) {
  return async function processLinearOAuthRevocation(event: OAuthEvent) {
    if (!isLinearOAuthRevocation(event)) return false
    const organizationId = typeof event.organizationId === 'string' ? event.organizationId.trim() : ''
    if (!organizationId) throw new Error('Linear OAuth revocation is missing its organization')

    if (event.type === 'OAuthAuthorization') {
      const linearUserId = typeof event.data?.userId === 'string' ? event.data.userId.trim() : ''
      if (!linearUserId) throw new Error('Linear OAuth revocation is missing its user')
      await store.revokeAuthorization(organizationId, linearUserId)
    } else {
      await store.revokeOrganization(organizationId)
    }
    return true
  }
}

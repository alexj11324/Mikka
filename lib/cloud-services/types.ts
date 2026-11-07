/** Public wire contract. The issuing service and its credentials live separately. */
export const CLOUD_SCOPES = ['github', 'computer', 'push', 'live', 'models', 'connectors'] as const
export type CloudScope = typeof CLOUD_SCOPES[number]
export const AVAILABLE_CLOUD_SCOPES = ['github', 'push', 'models'] as const satisfies readonly CloudScope[]

export type CloudRegistration = {
  serverId: string; serverSecret: string; origin: string; basePath: string; serviceUrl: string
}
export type CloudToken = {
  accessToken: string; refreshToken?: string; expiresAt: number; scopes: CloudScope[]
  serverId: string; workspaceId: string; subject: string; grantType: 'user' | 'server_key'
}
export type CloudConnectionView = {
  registered: boolean; serverId: string | null; serviceUrl: string; administrator: boolean
  pushContent: 'full' | 'reminder'
  team: { connected: boolean; scopes: CloudScope[] }
  personal: { connected: boolean; revoked: boolean; scopes: CloudScope[] }
}

export function cloudScopes(value: unknown): CloudScope[] | null {
  if (typeof value !== 'string') return null
  const values = value.trim().split(/\s+/)
  if (!values.length || values.some(scope => !(CLOUD_SCOPES as readonly string[]).includes(scope)) || new Set(values).size !== values.length) return null
  return values as CloudScope[]
}

/** Server-only provenance. Never accept this object from a request body. */
export const enterprisePrincipal = Symbol('enterprise-principal')
export type EnterprisePrincipal =
  | { kind: 'session'; sessionId: string }
  | { kind: 'pat'; tokenId: string; workspaceId: string }
  | { kind: 'delegation'; workspaceId?: string; credentialId: string; credentialKind: 'oauth' | 'run' }
  | { kind: 'admission'; runId: string; workspaceId: string }
  | { kind: 'collaboration'; authorizationId: string; workspaceId: string }

export type EnterpriseReader = { id: string; [enterprisePrincipal]?: EnterprisePrincipal }

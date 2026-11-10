/** Resource permissions never replace active Workspace/Enterprise authority.
 * A content grant is not a credential, device or billing authorization. */
export const RESOURCE_KINDS = ['project', 'task', 'thread', 'bot', 'chat', 'artifact'] as const
export type ResourceKind = typeof RESOURCE_KINDS[number]
export const RESOURCE_ACTIONS = ['canDiscover', 'canReadMetadata', 'canReadContent', 'canComment', 'canSteer', 'canApprove',
  'canManageAccess', 'canTransfer', 'canUseCredential', 'canUseMachine', 'canViewUsage', 'canViewBilling'] as const
export type ResourceAction = typeof RESOURCE_ACTIONS[number]
export type ResourceVisibility = 'shared' | 'private' | 'quarantined'
export type ResourceReference = { kind: ResourceKind; id: string; workspaceId: string }
export type ResourceSubject = { kind: 'account' | 'service'; id: string }
export type ResourcePolicy = ResourceReference & { ownerId: string | null; visibility: ResourceVisibility; revision: number;
  parentKind: ResourceKind | null; parentId: string | null; provenance: string; createdAt: Date; updatedAt: Date }
export type ResourceCapabilities = Record<ResourceAction, boolean>
export const SHARED_RESOURCE_ACTIONS: readonly ResourceAction[] = ['canDiscover', 'canReadMetadata', 'canReadContent', 'canComment', 'canSteer']
export const OWNER_RESOURCE_ACTIONS: readonly ResourceAction[] = [...SHARED_RESOURCE_ACTIONS, 'canApprove', 'canManageAccess', 'canTransfer', 'canViewUsage']
/** Only these can be granted through content-sharing APIs. The other resource
 * authorities have their own admission and must never be created by sharing. */
export const SHARING_GRANT_ACTIONS: readonly ResourceAction[] = ['canReadContent', 'canComment', 'canSteer', 'canApprove', 'canViewUsage']
export const deniedResourceCapabilities = (): ResourceCapabilities => Object.fromEntries(RESOURCE_ACTIONS.map(action => [action, false])) as ResourceCapabilities

/** The management view deliberately cannot transport a title, file name,
 * prompt, repository, tool output, secret or content-derived description. */
export type ResourceManagementMetadata = Pick<ResourcePolicy, 'kind' | 'id' | 'workspaceId' | 'ownerId' | 'visibility' | 'revision' | 'createdAt' | 'updatedAt'>
export function resourceManagementMetadata(policy: ResourcePolicy): ResourceManagementMetadata {
  const { kind, id, workspaceId, ownerId, visibility, revision, createdAt, updatedAt } = policy
  return { kind, id, workspaceId, ownerId, visibility, revision, createdAt, updatedAt }
}

/** Per-source pages can be fetched concurrently and rendered together by the client.
 * Historical sessions have owner scope; they have no workspace association. */
export type SearchSource = 'tasks' | 'history' | 'groups'
export type SearchItem = {
  id: string
  title: string
  timestamp: string
} & (
  | { type: 'task'; identifier: string | null; status: string; priority: string }
  | { type: 'history'; scope: 'owner' }
  | { type: 'group'; workspaceId: string }
)
export type SearchPage = { source: SearchSource; items: SearchItem[]; nextCursor: string | null }
export const unsupportedSources = { agents: 'productDefinitionRequired', knowledge: 'sourceAndAclRequired' } as const

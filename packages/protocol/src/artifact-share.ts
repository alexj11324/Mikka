import type { ShareVisibility } from './settings'

/** Scope is fixed when a link is created; later defaults do not rewrite it. */
export interface ArtifactShareScope {
  visibility: ShareVisibility
  workspaceId: string
}

export interface CreatedArtifactShare {
  token: string
  scope: ArtifactShareScope
  /** An explicit choice applies to this link, not to personal settings. */
  source: 'explicit' | 'workspace' | 'default'
}

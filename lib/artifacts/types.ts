import type { ArtifactKind } from '@/lib/db/schema'

// What the app shows of an artifact; shared by the server and the reader.

export interface ArtifactSummary {
  id: string
  kind: ArtifactKind
  title: string
  latestVersion: number
}

export interface ArtifactVersionInfo {
  version: number
  authorName: string
  /** The author bot's bloub colour and shape; null when no bot by that name, so the reader derives a colour from the name. */
  authorColor: string | null
  authorShape: string | null
  createdAt: string
}

export interface ArtifactDetail extends ArtifactSummary {
  runId: string | null
  issueId: string | null
  versions: ArtifactVersionInfo[]
  /** A share link is live. Only the owner's reads say; tokens are stored hashed, so a link can't be shown again. */
  shared?: boolean
}

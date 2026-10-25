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
  createdAt: string
}

export interface ArtifactDetail extends ArtifactSummary {
  runId: string | null
  issueId: string | null
  versions: ArtifactVersionInfo[]
}

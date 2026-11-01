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
  /** Set when a run's Agent wrote the version (Claude Code, Codex): it shows with the Agent's mark, not a bot's bloub (R-78). */
  authorHarness?: string | null
  createdAt: string
}

export interface ArtifactDetail extends ArtifactSummary {
  runId: string | null
  issueId: string | null
  versions: ArtifactVersionInfo[]
  /** A share link is live. Only the owner's reads say; tokens are stored hashed, so a link can't be shown again. */
  shared?: boolean
}

/** A row on the Artifact page: what it is, where it came from, when it last changed. */
export interface ArtifactListItem extends ArtifactSummary {
  runId: string | null
  issueId: string | null
  /** The bot whose run made it, so the reader sits beside that bot's chat; null outside a run or for the Coordinator. */
  botId: string | null
  /** Who made the latest version: the agent's name. */
  authorName: string | null
  /** The task it was made for, as 「MIK-41」; null without one. */
  issueKey: string | null
  updatedAt: string
}

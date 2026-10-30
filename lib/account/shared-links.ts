import 'server-only'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { artifactShares, artifacts, type ArtifactKind } from '@/lib/db/schema'

/** One artifact with live share links in 「已共享的链接」. Stopping it ends every link to the artifact. */
export interface SharedArtifactLink {
  artifactId: string
  title: string
  kind: ArtifactKind
  /** Live links to it; sharing again adds one, stopping ends them all. */
  links: number
  /** When the newest live link was made. */
  sharedAt: string
}

/** The person's own artifacts that anyone with a link can still open, newest share first. */
export async function listSharedArtifacts(userId: string): Promise<SharedArtifactLink[]> {
  const sharedAt = sql<Date>`max(${artifactShares.createdAt})`
  const found = await db.select({
    artifactId: artifacts.id, title: artifacts.title, kind: artifacts.kind,
    links: sql<number>`count(*)::int`, sharedAt,
  }).from(artifactShares)
    .innerJoin(artifacts, eq(artifacts.id, artifactShares.artifactId))
    .where(and(eq(artifacts.userId, userId), eq(artifactShares.createdBy, userId), isNull(artifactShares.revokedAt)))
    .groupBy(artifacts.id, artifacts.title, artifacts.kind)
    .orderBy(desc(sharedAt))
  return found.map(row => ({ ...row, sharedAt: new Date(row.sharedAt).toISOString() }))
}

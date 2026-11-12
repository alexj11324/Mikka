import 'server-only'
import type { JSONContent } from '@tiptap/core'
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm'
import type { db } from './db'
import { issueVersions } from './db/schema'

const { content: _body, ...summary } = getTableColumns(issueVersions)

/** The reader must hold the Task's content grant. Activity only needs metadata
 * from the recent window and the true creation revision. The document history
 * dialog loads historical bodies through its own authorized read. */
export function taskActivityVersions(reader: Pick<typeof db, 'select'>, issueId: string, ownerId: string) {
  const columns = { ...summary, content: sql<JSONContent>`jsonb_build_object('type', 'doc', 'attrs', ${issueVersions.content}->'attrs')`.as('content') }
  const scope = and(eq(issueVersions.issueId, issueId), eq(issueVersions.userId, ownerId))
  const recent = reader.select(columns).from(issueVersions).where(scope).orderBy(desc(issueVersions.revision), desc(issueVersions.id)).limit(50)
  const creation = reader.select(columns).from(issueVersions).where(and(scope, eq(issueVersions.revision, 1)))
  return recent.union(creation).as('activity_versions')
}

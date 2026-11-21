import 'server-only'
import type { JSONContent } from '@tiptap/core'
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm'
import type { db } from './db'
import { issueVersions } from './db/schema'

const { content: _body, ...summary } = getTableColumns(issueVersions)

/** The reader must hold the Task's content grant. Activity reads only the metadata
 * projection, never historical document bodies. The history dialog loads bodies separately. */
export function taskActivityVersions(reader: Pick<typeof db, 'select'>, issueId: string, ownerId: string) {
  const columns = {
    ...summary,
    // Activity never returns the body. Keep all revision metadata available so
    // frequent autosaves cannot evict older meaningful attribute changes.
    content: sql<JSONContent>`jsonb_build_object('type', 'doc', 'attrs', ${issueVersions.content}->'attrs')`.as('content'),
    // Compare body revisions in SQL; the activity payload receives only a boolean, never a body or hash.
    descriptionChanged: sql<boolean>`(${issueVersions.content}->'content') IS DISTINCT FROM LAG(${issueVersions.content}->'content') OVER (ORDER BY ${issueVersions.revision}, ${issueVersions.id})`.as('descriptionChanged'),
  }
  const scope = and(eq(issueVersions.issueId, issueId), eq(issueVersions.userId, ownerId))
  // The renderer pages activity rows, not raw revisions. Return all metadata-only
  // summaries so a burst of automatic description saves cannot displace older events.
  return reader.select(columns).from(issueVersions).where(scope).orderBy(desc(issueVersions.revision), desc(issueVersions.id)).as('activity_versions')
}

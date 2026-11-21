import 'server-only'
import type { JSONContent } from '@tiptap/core'
import { and, desc, eq, getTableColumns, lt, or, sql } from 'drizzle-orm'
import type { db } from './db'
import { issueVersions } from './db/schema'

const { content: _body, ...summary } = getTableColumns(issueVersions)

export const ISSUE_ACTIVITY_PAGE_SIZE = 100

/** The reader must hold the Task's content grant. Activity reads only the metadata
 * projection, never historical document bodies; the history dialog loads bodies separately.
 * With a limit, the inner keyset query bounds work to one page plus its look-ahead row.
 * LAG runs only over that bounded window; the look-ahead keeps the oldest returned row's
 * descriptionChanged flag correct at the page boundary. */
export function taskActivityVersions(
  reader: Pick<typeof db, 'select'>,
  issueId: string,
  ownerId: string,
  options: { before?: { revision: number; id: string }; limit?: number } = {},
) {
  const scope = and(
    eq(issueVersions.issueId, issueId),
    eq(issueVersions.userId, ownerId),
    options.before === undefined ? undefined : or(
      lt(issueVersions.revision, options.before.revision),
      and(eq(issueVersions.revision, options.before.revision), lt(issueVersions.id, options.before.id)),
    ),
  )
  const candidateQuery = reader.select({ ...summary, content: issueVersions.content })
    .from(issueVersions)
    .where(scope)
    .orderBy(desc(issueVersions.revision), desc(issueVersions.id))
    .$dynamic()
  const candidates = (options.limit === undefined ? candidateQuery : candidateQuery.limit(options.limit + 1)).as('activity_candidates')
  const { id, issueId: candidateIssueId, userId, revision, title, status, priority, actorType, actorId, sourceRunId, createdAt } = candidates
  const projected = reader.select({
    id, issueId: candidateIssueId, userId, revision, title, status, priority, actorType, actorId, sourceRunId, createdAt,
    // Only the document's attrs leave the database; body text is used solely for this boolean.
    content: sql<JSONContent>`jsonb_build_object('type', 'doc', 'attrs', ${candidates.content}->'attrs')`.as('content'),
    descriptionChanged: sql<boolean>`(${candidates.content}->'content') IS DISTINCT FROM LAG(${candidates.content}->'content') OVER (ORDER BY ${candidates.revision}, ${candidates.id})`.as('descriptionChanged'),
  }).from(candidates)
    .orderBy(desc(candidates.revision), desc(candidates.id))
  return options.limit === undefined ? projected.as('activity_versions') : projected.limit(options.limit + 1).as('activity_versions')
}

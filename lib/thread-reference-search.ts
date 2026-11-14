import 'server-only'
import { sql } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { issues } from '@/lib/db/schema'
import { parseSearchParams, searchIssues } from '@/lib/issue-search'
import { issueVisibility } from '@/lib/issue-visibility'
import { pullRequestSchema } from '@/lib/issue-metadata'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { conversationDirectory } from '@/lib/conversation-directory'
import type { ThreadReference } from './thread-references'

/** Only PRs attached to readable tasks are candidates. Match the title, URL or number before limiting. */
async function pullRequests(userId: string, workspaceId: string, query: string): Promise<ThreadReference[]> {
  const { predicate } = await issueVisibility(userId, false, workspaceId, db, { withTeamLinks: false })
  const rows = await db.execute<{ url: string; title: string | null; state: string }>(sql`
    SELECT DISTINCT ON (lower(link.url)) link.url, link.receipt->>'title' AS title, link.receipt->>'state' AS state
    FROM ${issues} JOIN task_pull_links link ON link."issueId"=${issues.id}
    WHERE ${predicate} AND (strpos(lower(coalesce(link.receipt->>'title','')), lower(${query}))>0
      OR strpos(lower(link.url), lower(${query}))>0 OR ('#'||substring(link.url from '/pull/([0-9]+)$'))=${query})
    ORDER BY lower(link.url), ${issues.updatedAt} DESC, ${issues.id}, link.ordinal LIMIT 8`)
  return rows.rows.flatMap(row => {
    const result = pullRequestSchema.safeParse({ url: row.url, title: row.title ?? undefined, state: row.state })
    return result.success ? [{ kind: 'pr' as const, id: result.data.url, title: result.data.title || result.data.url }] : []
  })
}

export async function searchThreadReferences(userId: string, workspaceId: string, query: string, kind?: ThreadReference['kind']) {
  return withTaskWorkspace(userId, workspaceId, async () => {
    const [tasks, threads, prs] = await Promise.all([
      kind && kind !== 'task' ? null : searchIssues(db, { userId, workspaceId, params: parseSearchParams(new URLSearchParams({ q: query, limit: '8', workspaceId })) }),
      kind && kind !== 'thread' ? null : conversationDirectory(pool, userId, workspaceId, { search: query }),
      kind && kind !== 'pr' ? [] : pullRequests(userId, workspaceId, query),
    ])
    return [
      ...tasks?.items.map(item => ({ kind: 'task' as const, id: item.id, title: [item.identifier, item.title].filter(Boolean).join(' ') })) ?? [],
      ...threads?.items.slice(0, 8).map(item => ({ kind: 'thread' as const, id: item.id, title: item.title,
        ...(item.kind === 'chat' ? { conversationKind: 'chat' as const } : {}) })) ?? [],
      ...prs,
    ]
  })
}

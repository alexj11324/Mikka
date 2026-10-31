import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { pool } from '@/lib/db'

const pullRequestEvent = z.object({
  repository: z.object({ full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  pull_request: z.object({
    number: z.number().int().positive(),
    html_url: z.url(), title: z.string().max(256),
    state: z.enum(['open', 'closed']), draft: z.boolean(), merged_at: z.string().nullable(),
  }),
})

/** Called only after verification of the GitHub webhook signature. Updates only
 * deliveries already associated with this exact repository and PR URL. */
export async function refreshPublishedPullRequest(event: string, payload: unknown, database: Pick<Pool, 'query'> = pool) {
  if (event !== 'pull_request') return
  const parsed = pullRequestEvent.safeParse(payload)
  if (!parsed.success) return
  const { repository, pull_request: pr } = parsed.data
  const url = `https://github.com/${repository.full_name}/pull/${pr.number}`
  if (pr.html_url !== url) return
  const state = pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : pr.draft ? 'draft' : 'open'
  await database.query(`UPDATE run_publications SET "pullRequest"="pullRequest" || $2::jsonb,"updatedAt"=now()
    WHERE "pullRequest"->>'url'=$1`, [url, JSON.stringify({ title: pr.title, state })])
}

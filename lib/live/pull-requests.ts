import type { PoolClient } from 'pg'
import { afterDatabaseCommit } from '../db/commit-effects'
import { LIVE_ID, type LiveInvalidation } from './events'
import { liveGatewayConfig, type LiveScope } from './scope'

type Database = Pick<PoolClient, 'query'>
type Target = { scope: LiveScope; events: LiveInvalidation[] }

/** One webhook names one PR; the tasks it was delivered on are few. Beyond this, open badges catch up on their own read. */
const MAX_TASKS = 50

/** A linked pull request's state shows on its task. Each task's key (`pull_request_status`, the task ID) goes to
 * that task's own audience, re-checked when sent. The badge then asks GitHub with the
 * viewer's own access; no PR state, title or URL crosses the channel. */
export async function pullRequestStatusTargets(database: Database, workspaceDatabase: Database, issueIds: readonly string[]): Promise<Target[]> {
  const ids = [...new Set(issueIds.filter(id => LIVE_ID.test(id)))].slice(0, MAX_TASKS)
  const { issueAudienceTargets } = await import('./panels')
  return issueAudienceTargets(database, workspaceDatabase, ids, 'pull_request_status')
}

/** A GitHub webhook committed a delivered PR's state. Sent after COMMIT; a failed write sends nothing. */
export async function pullRequestStatusChanged(executor: object, issueIds: readonly string[]) {
  if (!issueIds.length || !liveGatewayConfig(process.env)) return
  const { scheduleLive, sendLiveInvalidations } = await import('./notify')
  afterDatabaseCommit(executor, `pull_request_status:${[...new Set(issueIds)].sort().join(',')}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    const { workspacePool } = await import('../workspace-db')
    await withoutDatabaseClient(async () => {
      const sends: Promise<void>[] = []
      // One request carries at most 16 keys (lib/live/events.ts).
      for (const target of await pullRequestStatusTargets(pool, workspacePool, issueIds)) for (let start = 0; start < target.events.length; start += 16) {
        sends.push(sendLiveInvalidations(target.scope, target.events.slice(start, start + 16)))
      }
      await Promise.all(sends)
    })
  }))
}

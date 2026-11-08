import type { PoolClient } from 'pg'
import { withDatabaseClient } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { factoryWorkspaceReader } from './workspace-reader'

/** Only access is needed; retain canonical scope/deletion checks without the task body. */
export const factoryAuthorize = (userId: string, issueId: string, tx: PoolClient) =>
  withDatabaseClient(tx, async () => Boolean(await issueForUser(await factoryWorkspaceReader(userId), issueId, false, undefined, { withoutBody: true })))

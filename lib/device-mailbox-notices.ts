import 'server-only'
import { pool } from '@/lib/db'
import type { RunCommand } from '@mikka/protocol/device'

/** The committed mailbox row is the durable notification outbox. No peer
 * body enters the device command or the person's input channel. */
export async function pendingMailboxNotices(deviceId: string, runIds: readonly string[]): Promise<RunCommand[]> {
  if (!runIds.length) return []
  const { rows } = await pool.query<{ runId: string; messageId: string }>(`
    SELECT r.id AS "runId", message.id AS "messageId"
    FROM run_messages message
    JOIN session_mailboxes mailbox ON mailbox.id=message."mailboxId"
    JOIN agent_runs r ON r."mailboxId"=mailbox.id AND mailbox."latestRunId"=r.id
    JOIN devices device ON device.id=r."deviceId" AND device."ownerId"=r."userId"
    WHERE r."deviceId"=$1 AND r.id=ANY($2::uuid[])
      AND r.status IN ('preparing','running','waiting_input')
      AND r."stopRequestedAt" IS NULL AND r."leaseExpiresAt">clock_timestamp()
      AND device.enabled AND device."removedAt" IS NULL
      AND mailbox.kind='run' AND NOT mailbox.disabled
      AND mailbox."userId"=r."userId" AND message."userId"=r."userId"
      AND message."runId" IS NULL AND message."mailboxNotifiedAt" IS NULL
      AND message."acknowledgedAt" IS NULL AND message.failure IS NULL
      AND message."mailboxWakeDepth" < 8
    ORDER BY message.sequence LIMIT 500`, [deviceId, runIds])
  const grouped = new Map<string, string[]>()
  for (const row of rows) {
    const ids = grouped.get(row.runId) ?? []
    if (ids.length < 50) ids.push(row.messageId)
    grouped.set(row.runId, ids)
  }
  return [...grouped].map(([runId, messageIds]) => ({ kind: 'mailbox_notice', runId, messageIds }))
}

/** Receipt means the host handed over a notice, never that the inbox was
 * read, its message acknowledged or the requested work executed. */
export async function ackMailboxNotices(deviceId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return
  await pool.query(`UPDATE run_messages message
    SET "mailboxNotifiedAt"=coalesce(message."mailboxNotifiedAt",clock_timestamp())
    FROM session_mailboxes mailbox
    JOIN agent_runs r ON r."mailboxId"=mailbox.id AND mailbox."latestRunId"=r.id
    JOIN devices device ON device.id=r."deviceId" AND device."ownerId"=r."userId"
    WHERE message."mailboxId"=mailbox.id AND r."deviceId"=$1
      AND message.id=ANY($2::uuid[]) AND message."runId" IS NULL
      AND mailbox.kind='run' AND NOT mailbox.disabled
      AND mailbox."userId"=r."userId" AND message."userId"=r."userId"
      AND device.enabled AND device."removedAt" IS NULL`, [deviceId, ids])
}

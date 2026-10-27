import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import * as provider from './e2b-provider'

/** Stream the preserved repository and worktree to their owner. The sandbox
 * contains no worker credential; closing or cancelling the stream destroys it. */
export async function threadResultDownload(pool: Pool, actor: { userId: string; workspaceId: string }, runId: string, runtime = provider) {
  z.uuid().parse(runId)
  const row = (await pool.query(`SELECT t."resultSnapshotId" FROM thread_machines t
    JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
    WHERE t."runId"=$1 AND t."workspaceId"=$2 AND t."ownerId"=$3 AND t.state='ended'
      AND r.status IN ('succeeded','failed','stopped','cancelled')`, [runId, actor.workspaceId, actor.userId])).rows[0]
  if (!row?.resultSnapshotId) return null
  const sandbox = await runtime.createResultReader(row.resultSnapshotId, runId)
  const archive = `/tmp/mikka-export-${randomUUID()}.tar.gz`
  let source: ReadableStream<Uint8Array> | undefined
  try {
    const worktree = `/home/mikka-runner/.mikka/worker/worktrees/${runId}`
    await sandbox.commands.run(`umask 077; if test -d ${worktree}; then tar -czf ${archive} -C / workspace -C /home/mikka-runner/.mikka/worker worktrees/${runId}; else tar -czf ${archive} -C / workspace; fi`, { user: 'mikka-runner', timeoutMs: 180_000 })
    source = await sandbox.files.read(archive, { user: 'mikka-runner', format: 'stream', streamIdleTimeoutMs: 60_000 })
  } catch (error) { await sandbox.kill().catch(() => undefined); throw error }
  const reader = source.getReader()
  let closed = false
  async function cleanup() {
    if (closed) return
    closed = true
    await sandbox.kill().catch(() => undefined)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) { controller.close(); await cleanup() } else controller.enqueue(result.value)
      } catch (error) { controller.error(error); await cleanup() }
    },
    async cancel() { await reader.cancel().catch(() => undefined); await cleanup() },
  })
}

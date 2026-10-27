import 'server-only'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Pool } from 'pg'
import type { Sandbox } from 'e2b'
import * as provider from './e2b-provider'
import { ThreadMachines } from './thread-machine'
import { collectRetiredSnapshots } from './workspace-snapshot'

type Actor = { userId: string; workspaceId: string }

/** Preserve the repository and the run's worktree in a clean filesystem-only
 * snapshot before destroying a completed machine. No worker home or device
 * credential is copied. If preservation fails, the machine is retained. */
export async function preserveThreadResult(pool: Pool, actor: Actor, runId: string, runtime = provider) {
  z.uuid().parse(runId)
  const client = await pool.connect()
  let source: Sandbox | undefined, stage: Sandbox | undefined, resultSnapshot: string | undefined, committed = false
  const suffix = randomUUID(), workspaceTar = `/tmp/mikka-result-${suffix}.tar`, worktreeTar = `/tmp/mikka-worktree-${suffix}.tar`
  const worktree = `/home/mikka-runner/.mikka/worker/worktrees/${runId}`
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-result:${runId}`])
    const row = (await client.query(`SELECT t."sandboxId",t."resultSnapshotId",r.status,r."startedAt",r."worktreePath"
      FROM thread_machines t JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
      WHERE t."runId"=$1 AND t."workspaceId"=$2 AND t."ownerId"=$3 FOR UPDATE OF t,r`, [runId, actor.workspaceId, actor.userId])).rows[0]
    if (!row) { await client.query('COMMIT'); committed = true; return null }
    if (!['succeeded', 'failed', 'stopped', 'cancelled'].includes(row.status)) throw new Error('Thread is still active')
    if (row.resultSnapshotId || !row.startedAt) { await client.query('COMMIT'); committed = true; return row.resultSnapshotId as string | null }
    if (!row.sandboxId || (row.worktreePath && row.worktreePath !== worktree)) throw new Error('Thread worktree unavailable')
    const expectedSha = process.env.MIKKA_CLOUD_WORKER_SHA
    if (!expectedSha || !/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error('Cloud worker is not configured')
    source = await runtime.connectComputer(row.sandboxId)
    // A thread can outlive a deployment. Its worker was pinned when its
    // snapshot was created; requiring the *current* version here strands its
    // work after an upgrade. The source is the owner-bound sandbox recorded
    // for this run and its marker is root-owned. The clean destination below
    // is still required to match the current trusted template exactly.
    const revision = await source.files.read('/opt/mikka/worker-source-sha', { user: 'root' })
    if (!/^[a-f0-9]{40}$/.test(revision.trim())) throw new Error('Cloud worker version unavailable')
    const hasWorktree = (await source.commands.run(`umask 077; tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf ${workspaceTar} -C /workspace .; if test -d ${worktree}; then tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf ${worktreeTar} -C ${worktree} .; printf yes; else printf no; fi`, { user: 'mikka-runner', timeoutMs: 180_000 })).stdout.trim()
    if (hasWorktree !== 'yes' && hasWorktree !== 'no') throw new Error('Thread worktree unavailable')
    if (row.worktreePath && hasWorktree !== 'yes') throw new Error('Thread worktree unavailable')
    stage = await runtime.createWorkspaceSnapshotStage()
    if ((await stage.files.read('/opt/mikka/worker-source-sha', { user: 'root' })).trim() !== expectedSha) throw new Error('Cloud worker version mismatch')
    await stage.commands.run('install -d -o mikka-runner -g mikka-runner -m 0700 /workspace /home/mikka-runner/.mikka/worker/worktrees; test -z "$(ls -A /workspace)"', { user: 'root', timeoutMs: 10_000 })
    const workspaceStream = await source.files.read(workspaceTar, { user: 'mikka-runner', format: 'stream', streamIdleTimeoutMs: 60_000 })
    await stage.files.write('/tmp/mikka-workspace.tar', workspaceStream, { user: 'mikka-runner', requestTimeoutMs: 180_000 })
    if (hasWorktree === 'yes') {
      const worktreeStream = await source.files.read(worktreeTar, { user: 'mikka-runner', format: 'stream', streamIdleTimeoutMs: 60_000 })
      await stage.files.write('/tmp/mikka-worktree.tar', worktreeStream, { user: 'mikka-runner', requestTimeoutMs: 180_000 })
    }
    await stage.files.write('/opt/mikka/computer/extract-workspace.py', await readFile(join(process.cwd(), 'scripts/e2b/extract-workspace.py'), 'utf8'), { user: 'root' })
    await stage.files.write('/opt/mikka/computer/validate-workspace.py', await readFile(join(process.cwd(), 'scripts/e2b/validate-workspace.py'), 'utf8'), { user: 'root' })
    await stage.commands.run(`python3 /opt/mikka/computer/extract-workspace.py${hasWorktree === 'yes' ? ` && python3 /opt/mikka/computer/extract-workspace.py ${runId}` : ''} && python3 /opt/mikka/computer/validate-workspace.py && git -C /workspace rev-parse --verify HEAD >/dev/null && rm -f /tmp/mikka-workspace.tar /tmp/mikka-worktree.tar`, { user: 'mikka-runner', timeoutMs: 180_000 })
    resultSnapshot = (await runtime.createWorkspaceSnapshot(stage)).snapshotId
    await client.query('UPDATE thread_machines SET "resultSnapshotId"=$2 WHERE "runId"=$1', [runId, resultSnapshot])
    await client.query('COMMIT'); committed = true
    return resultSnapshot
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error } finally {
    client.release()
    if (source) await source.commands.run(`rm -f ${workspaceTar} ${worktreeTar}`, { user: 'mikka-runner', timeoutMs: 10_000 }).catch(() => undefined)
    if (stage) await stage.kill().catch(() => undefined)
    if (resultSnapshot && !committed) {
      const published = await pool.query('SELECT 1 FROM thread_machines WHERE "resultSnapshotId"=$1', [resultSnapshot]).catch(() => null)
      if (published && !published.rowCount) await runtime.deleteWorkspaceSnapshot(resultSnapshot).catch(() => undefined)
    }
  }
}

export async function finalizeCloudThread(pool: Pool, actor: Actor, runId: string, runtime = provider) {
  await preserveThreadResult(pool, actor, runId, runtime)
  await new ThreadMachines(pool, runtime.threadMachineProvider).end(actor, runId)
  await collectRetiredSnapshots(pool, actor, runtime)
}

/** Periodic retry for an interrupted completion. Each attempt is idempotent;
 * preservation failure leaves the original sandbox available for retry. */
export async function reconcileFinishedThreads(pool: Pool, limit = 1) {
  const pending = await pool.query(`SELECT t."runId",t."workspaceId",t."ownerId" FROM thread_machines t
    JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId"
    WHERE t.state<>'ended' AND r.status IN ('succeeded','failed','stopped','cancelled')
    ORDER BY r."finishedAt" NULLS LAST,t."createdAt" LIMIT $1`, [Math.max(1, Math.min(limit, 10))])
  let finished = 0, failed = 0
  for (const row of pending.rows) {
    try { await finalizeCloudThread(pool, { userId: row.ownerId, workspaceId: row.workspaceId }, row.runId); finished++ }
    catch { failed++ }
  }
  return { examined: pending.rows.length, finished, failed }
}

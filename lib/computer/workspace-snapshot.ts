import 'server-only'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Pool } from 'pg'
import type { Sandbox } from 'e2b'
import * as provider from './e2b-provider'
import { snapshotRefreshReason } from './snapshot-policy'

type Actor = { userId: string; workspaceId: string }

/** Archive only the selected owner's Bot workspace, stream it through the
 * control plane into a fresh template, and snapshot that clean filesystem.
 * The Bot's home, browser profiles, daemon token and E2B key never enter the
 * staging sandbox. The archive hash covers source, lockfiles and dependencies. */
export async function prepareWorkspaceSnapshot(pool: Pool, actor: Actor, runId: string, botId: string, sourceSha: string, runtime = provider) {
  z.uuid().parse(runId); z.uuid().parse(botId)
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid worker revision')
  const client = await pool.connect()
  let source: Sandbox | undefined, stage: Sandbox | undefined, createdSnapshot: string | undefined, committed = false
  const archive = `/tmp/mikka-workspace-${randomUUID()}.tar`
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-snapshot:${actor.workspaceId}:${actor.userId}`])
    const run = (await client.query(`SELECT r.status,r."stopRequestedAt",m."sandboxId",repo."repoPath" FROM agent_runs r
      JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId" AND m.state='running'
      JOIN bot_cloud_runtimes br ON br."botId"=b."botId" AND br."workspaceId"=b."workspaceId" AND br."ownerId"=b."ownerId" AND br."agentId"=r."agentId"
      JOIN device_repos repo ON repo.id=br."repoId" AND repo."userId"=b."ownerId"
      WHERE r.id=$1 AND b."workspaceId"=$2 AND b."ownerId"=$3 AND b."botId"=$4
        AND NOT EXISTS (SELECT 1 FROM workspace_computer_policies p WHERE p."workspaceId"=b."workspaceId" AND p.permission='deny') FOR UPDATE OF r`,
    [runId, actor.workspaceId, actor.userId, botId])).rows[0]
    if (!run || run.status !== 'queued' || run.stopRequestedAt || !run.sandboxId || run.repoPath !== `/home/mikka-runner/.mikka/bot-workspaces/${botId}`) throw new Error('Workspace snapshot unavailable')
    const prior = (await client.query('SELECT "snapshotId" FROM thread_machines WHERE "runId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3', [runId, actor.workspaceId, actor.userId])).rows[0]
    if (prior) { await client.query('COMMIT'); committed = true; return prior.snapshotId as string }
    source = await runtime.connectComputer(run.sandboxId)
    const revision = await source.files.read('/opt/mikka/worker-source-sha', { user: 'root' })
    // An existing Bot may predate the current deployment. Its owner-bound
    // machine can supply the workspace, while the clean staging image below
    // must be pinned to the current trusted worker revision.
    if (!/^[a-f0-9]{40}$/.test(revision.trim())) throw new Error('Cloud worker version unavailable')
    const result = await source.commands.run(`umask 077; git -C ${run.repoPath} rev-parse --verify HEAD >/dev/null; tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf ${archive} -C ${run.repoPath} .; sha256sum ${archive} | cut -d ' ' -f1`, { user: 'mikka-runner', timeoutMs: 180_000 })
    const fingerprint = result.stdout.trim()
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Workspace archive unavailable')
    const active = (await client.query('SELECT "snapshotId","dependencyFingerprint","sourceRevision","createdAt" FROM workspace_snapshots WHERE "workspaceId"=$1 AND "ownerId"=$2 FOR UPDATE', [actor.workspaceId, actor.userId])).rows[0]
    let snapshotId = active?.snapshotId as string | undefined
    if (snapshotRefreshReason(active ?? null, { dependencyFingerprint: fingerprint, sourceRevision: sourceSha, now: new Date() })) {
      stage = await runtime.createWorkspaceSnapshotStage()
      const stageRevision = await stage.files.read('/opt/mikka/worker-source-sha', { user: 'root' })
      if (stageRevision.trim() !== sourceSha) throw new Error('Cloud worker version mismatch')
      await stage.commands.run('install -d -o mikka-runner -g mikka-runner -m 0700 /workspace; test -z "$(ls -A /workspace)"', { user: 'root', timeoutMs: 10_000 })
      const contents = await source.files.read(archive, { user: 'mikka-runner', format: 'stream', streamIdleTimeoutMs: 60_000 })
      await stage.files.write('/tmp/mikka-workspace.tar', contents, { user: 'mikka-runner', requestTimeoutMs: 180_000 })
      const extractor = await readFile(join(process.cwd(), 'scripts/e2b/extract-workspace.py'), 'utf8')
      await stage.files.write('/opt/mikka/computer/extract-workspace.py', extractor, { user: 'root' })
      await stage.files.write('/opt/mikka/computer/validate-workspace.py', await readFile(join(process.cwd(), 'scripts/e2b/validate-workspace.py'), 'utf8'), { user: 'root' })
      await stage.commands.run('python3 /opt/mikka/computer/extract-workspace.py && python3 /opt/mikka/computer/validate-workspace.py && git -C /workspace rev-parse --verify HEAD >/dev/null && rm /tmp/mikka-workspace.tar', { user: 'mikka-runner', timeoutMs: 180_000 })
      snapshotId = (await runtime.createWorkspaceSnapshot(stage)).snapshotId
      createdSnapshot = snapshotId
      await client.query('INSERT INTO workspace_snapshot_versions ("snapshotId","workspaceId","ownerId") VALUES ($1,$2,$3)', [snapshotId, actor.workspaceId, actor.userId])
      if (active?.snapshotId) await client.query('UPDATE workspace_snapshot_versions SET "retiredAt"=now() WHERE "snapshotId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3', [active.snapshotId, actor.workspaceId, actor.userId])
      await client.query(`INSERT INTO workspace_snapshots ("workspaceId","ownerId","snapshotId","dependencyFingerprint","sourceRevision","createdAt")
        VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT ("workspaceId","ownerId") DO UPDATE SET "snapshotId"=EXCLUDED."snapshotId",
        "dependencyFingerprint"=EXCLUDED."dependencyFingerprint","sourceRevision"=EXCLUDED."sourceRevision","createdAt"=EXCLUDED."createdAt"`,
      [actor.workspaceId, actor.userId, snapshotId, fingerprint, sourceSha])
    }
    if (!snapshotId) throw new Error('Workspace snapshot unavailable')
    await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","snapshotId","operationId")
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("runId") DO NOTHING`, [runId, actor.workspaceId, actor.userId, snapshotId, randomUUID()])
    await client.query('COMMIT'); committed = true
    return snapshotId
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
    if (source) await source.commands.run(`rm -f ${archive}`, { user: 'mikka-runner', timeoutMs: 10_000 }).catch(() => undefined)
    if (stage) await stage.kill().catch(() => undefined)
    // On ambiguous commit failure, delete only after independently proving
    // the provider snapshot was not published in the database.
    if (createdSnapshot && !committed) {
      const published = await pool.query('SELECT 1 FROM workspace_snapshot_versions WHERE "snapshotId"=$1', [createdSnapshot]).catch(() => null)
      if (published && !published.rowCount) await runtime.deleteWorkspaceSnapshot(createdSnapshot).catch(() => undefined)
    }
  }
}

/** Delete only retired snapshots no live or resumable thread references. */
export async function collectRetiredSnapshots(pool: Pool, actor: Actor, runtime = provider) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`workspace-snapshot:${actor.workspaceId}:${actor.userId}`])
    const retired = await client.query(`SELECT v."snapshotId" FROM workspace_snapshot_versions v
      WHERE v."workspaceId"=$1 AND v."ownerId"=$2 AND v."retiredAt" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM workspace_snapshots s WHERE s."snapshotId"=v."snapshotId")
        AND NOT EXISTS (SELECT 1 FROM thread_machines t WHERE t."snapshotId"=v."snapshotId" AND t.state<>'ended') FOR UPDATE`, [actor.workspaceId, actor.userId])
    for (const row of retired.rows) {
      await runtime.deleteWorkspaceSnapshot(row.snapshotId)
      await client.query('DELETE FROM workspace_snapshot_versions WHERE "snapshotId"=$1', [row.snapshotId])
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

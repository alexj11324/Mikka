import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { deviceIsOnline } from '@/lib/device-presence'
import { GovernanceError } from '@/lib/governance/errors'
import type { EnterpriseReader } from '@/lib/enterprise/principal'
import type { DeviceMigrationCapability, DeviceSettingsDetail } from './device-activity-contract'

const scope = z.object({ workspaceId: z.uuid(), deviceId: z.uuid() }).strict()

const deviceMigrationCapability: DeviceMigrationCapability = {
  available: false,
  reason: 'machine_migration_not_supported',
  preserves: ['repository_checkpoint'],
  excludes: ['process_memory', 'native_session', 'ignored_files', 'credentials'],
}

type DeviceRow = DeviceSettingsDetail['hardware'] & {
  id: string; ownerId: string; name: string; description: string | null
  kind: 'local' | 'cloud'; deviceType: 'laptop' | 'server'
  lastSeenAt: Date | null; createdAt: Date; enabled: boolean; maxConcurrentRuns: number
  sessionOpenedAt: Date | null; sessionClosedAt: Date | null; activeRuns: number
}

/** Device ownership, current Workspace membership and content ACLs all apply. */
export async function readDeviceSettingsDetail(reader: EnterpriseReader, input: z.infer<typeof scope>): Promise<DeviceSettingsDetail> {
  const { workspaceId, deviceId } = scope.parse(input)
  return withTaskWorkspace(reader, workspaceId, () => writeTransaction(pool, async tx => {
    const { rows: [device] } = await tx.query<DeviceRow>(`SELECT d.id,d."ownerId",d.name,d.description,d.kind,d."deviceType",
      d.hostname,d.platform,d.arch,d."daemonVersion",d."protocolVersion",d.harnesses,d.enabled,d."maxConcurrentRuns",
      d."lastSeenAt",d."createdAt",d."sessionOpenedAt",d."sessionClosedAt",
      (SELECT count(*)::int FROM agent_runs r WHERE r."deviceId"=d.id AND r."userId"=d."ownerId"
        AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')) AS "activeRuns"
      FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d."removedAt" IS NULL FOR SHARE OF d`, [deviceId, reader.id])
    if (!device) throw new GovernanceError('not_found')
    const { rows: directories } = await tx.query<{ projectId: string; root: string; updatedAt: Date }>(`SELECT c."projectId",c.root,c."updatedAt"
      FROM device_project_checkouts c WHERE c."deviceId"=$1 AND c."ownerId"=$2 AND c."workspaceId"=$3
        AND mikka_resource_acl_allowed('account',$2,c."workspaceId",'project',c."projectId",'canReadContent')
      ORDER BY c.root,c."projectId"`, [deviceId, reader.id, workspaceId])
    // Environment bindings live in the Workspace database. A bookmark's Project
    // id is not an Environment id and must not be relabelled as one in the API.
    const { rows: bindings } = directories.length
      ? await workspacePool.query<{ projectId: string; environmentIds: string[] }>(`SELECT p.id AS "projectId",
        coalesce(array_agg(e.id ORDER BY e.id) FILTER(WHERE e.id IS NOT NULL),'{}'::uuid[]) AS "environmentIds"
        FROM workspace_projects p LEFT JOIN workspace_project_environments b ON b."projectId"=p.id AND b."workspaceId"=p."workspaceId"
        LEFT JOIN workspace_environments e ON e.id=b."environmentId" AND e."workspaceId"=b."workspaceId" AND e."archivedAt" IS NULL
        WHERE p."workspaceId"=$1 AND p.id=ANY($2::uuid[]) AND p."archivedAt" IS NULL
        GROUP BY p.id ORDER BY p.id`, [workspaceId, directories.map(row => row.projectId)])
      : { rows: [] }
    const { rows: checkpoints } = await tx.query<{ runId: string; baseCommit: string; files: number; takenAt: Date; unavailableReason: 'too_large' | null }>(`SELECT c."runId",c."baseCommit",c.files,c."takenAt",c."unavailableReason"
      FROM run_checkpoints c JOIN agent_runs r ON r.id=c."runId" AND r."userId"=c."userId"
      WHERE r."deviceId"=$1 AND r."userId"=$2 AND r."workspaceId"=$3
        AND (r."issueId" IS NULL OR mikka_resource_acl_allowed('account',$2,r."workspaceId",'task',r."issueId",'canReadContent'))
      ORDER BY c."takenAt" DESC,c."runId" LIMIT 100`, [deviceId, reader.id, workspaceId])
    const { rows: snapshots } = await tx.query<{ runId: string; snapshotState: DeviceSettingsDetail['cloudCheckpoints'][number]['state']; snapshotTakenAt: Date | null; available: boolean }>(`SELECT t."runId",t."snapshotState",t."snapshotTakenAt",
      (t."snapshotState"='ready' AND t."filesystemSnapshotId" IS NOT NULL) AS available
      FROM thread_machines t JOIN agent_runs r ON r.id=t."runId" AND r."userId"=t."ownerId" AND r."workspaceId"=t."workspaceId"
      WHERE t."deviceId"=$1 AND t."ownerId"=$2 AND t."workspaceId"=$3
        AND (r."issueId" IS NULL OR mikka_resource_acl_allowed('account',$2,r."workspaceId",'task',r."issueId",'canReadContent'))
      ORDER BY t."snapshotTakenAt" DESC NULLS LAST,t."runId" LIMIT 100`, [deviceId, reader.id, workspaceId])
    const online = deviceIsOnline(device)
    return {
      workspaceId,
      device: { id: device.id, name: device.name, description: device.description, kind: device.kind, deviceType: device.deviceType,
        online, lastSeenAt: device.lastSeenAt?.toISOString() ?? null, createdAt: device.createdAt.toISOString() },
      hardware: { hostname: device.hostname, platform: device.platform, arch: device.arch, daemonVersion: device.daemonVersion,
        protocolVersion: device.protocolVersion, harnesses: device.harnesses },
      access: { ownerId: device.ownerId, canManage: device.kind === 'local' },
      directories: directories.flatMap(row => {
        const binding = bindings.find(binding => binding.projectId === row.projectId)
        return binding ? [{ root: row.root, updatedAt: row.updatedAt.toISOString(), environmentIds: binding.environmentIds }] : []
      }),
      scheduling: { enabled: device.enabled, maxConcurrentRuns: device.maxConcurrentRuns, activeRuns: device.activeRuns,
        availableSlots: device.enabled && online ? Math.max(0, device.maxConcurrentRuns - device.activeRuns) : 0 },
      checkpoints: checkpoints.map(row => ({ runId: row.runId, kind: 'repository', baseCommit: row.baseCommit, files: row.files,
        capturedAt: row.takenAt.toISOString(), available: row.unavailableReason === null, unavailableReason: row.unavailableReason })),
      cloudCheckpoints: snapshots.map(row => ({ runId: row.runId, state: row.snapshotState,
        capturedAt: row.snapshotTakenAt?.toISOString() ?? null, available: row.available })),
      migration: deviceMigrationCapability,
    }
  }))
}

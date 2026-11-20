import 'server-only'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { ActionFailureError } from '@/lib/action-error'
import { ownerListChanged } from '@/lib/live/lists'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
import type { DeviceConcurrencySettings } from '@mikka/protocol/settings'
import { deviceConcurrencyInput } from './device-input'
import type { SettingsContext } from './store'

/** Admins need a current device-to-workspace binding; another membership alone grants no device access. */
export async function writeDeviceConcurrency(context: SettingsContext, deviceId: string, raw: unknown): Promise<DeviceConcurrencySettings> {
  z.uuid().parse(deviceId)
  const { maxConcurrentRuns } = deviceConcurrencyInput.parse(raw)
  const result = await workspaceDb.transaction(async workspace => {
    const { membership } = await requireWorkspace(workspace, context.workspaceId, context.userId)
    return db.transaction(async tx => {
      const { rows: [device] } = await tx.execute<{ ownerId: string }>(sql`SELECT "ownerId" FROM devices
        WHERE id=${deviceId} AND "removedAt" IS NULL FOR UPDATE`)
      if (!device) throw new ActionFailureError('deviceNotFound')
      if (device.ownerId !== context.userId) {
        if (membership.role !== 'admin') throw new WorkspaceError('workspaceAccessDenied')
        await requireWorkspace(workspace, context.workspaceId, device.ownerId)
        const binding = await tx.execute(sql`SELECT 1 FROM device_project_checkouts
          WHERE "deviceId"=${deviceId} AND "ownerId"=${device.ownerId} AND "workspaceId"=${context.workspaceId}
          UNION ALL SELECT 1 FROM thread_machines WHERE "deviceId"=${deviceId}
            AND "ownerId"=${device.ownerId} AND "workspaceId"=${context.workspaceId} LIMIT 1`)
        if (!binding.rowCount) throw new WorkspaceError('workspaceAccessDenied')
      }
      await tx.execute(sql`UPDATE devices SET "maxConcurrentRuns"=${maxConcurrentRuns},"updatedAt"=now() WHERE id=${deviceId}`)
      await ownerListChanged(tx, device.ownerId, ['thread_list', 'device_list'])
      return { deviceId, maxConcurrentRuns }
    })
  })
  notifyDeviceWork(deviceId)
  return result
}

import 'server-only'
import { sql } from 'drizzle-orm'
import { posix, win32 } from 'node:path'
import { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { deviceCheckoutsChanged } from '@/lib/live/lists'
import { GovernanceError } from '@/lib/governance/errors'
import { withReadableProject } from '@/lib/project-access'
import type { ApiSession } from '@/lib/api-auth'

export type DeviceCheckout = { deviceId: string; projectId: string; root: string; updatedAt: string }
const scope = z.object({ workspaceId: z.uuid(), projectId: z.uuid() })
const device = scope.extend({ deviceId: z.uuid() })
const root = z.string().min(1).max(1024).refine(value =>
  !Array.from(value).some(char => char.charCodeAt(0) < 32) && (posix.isAbsolute(value) || win32.isAbsolute(value)))
export const setCheckoutBody = z.object({ projectId: z.uuid(), root }).strict()
export const clearCheckoutBody = z.object({ projectId: z.uuid() }).strict()

// The path is a person's displayable bookmark. It is never a scheduling
// record, execution root, storage URL or invitation to read the filesystem.
async function underProject<T>(session: ApiSession, ref: z.infer<typeof scope>, work: Parameters<typeof withReadableProject<T>>[3]) {
  if (session.tokenId) throw new GovernanceError('access_denied')
  try {
    return await withReadableProject(session.user, ref.workspaceId, ref.projectId, work)
  } catch (error) {
    if (error instanceof ActionFailureError && (error.code === 'projectNotFound' || error.code === 'issueNotFound')) {
      throw new GovernanceError('not_found', error)
    }
    throw error
  }
}

export async function listDeviceCheckouts(session: ApiSession, input: z.infer<typeof scope>) {
  const ref = scope.parse(input)
  return underProject(session, ref, async app => {
    const { rows } = await app.execute<DeviceCheckout>(sql`
      select c."deviceId", c."projectId", c.root, c."updatedAt" from device_project_checkouts c
      join devices d on d.id=c."deviceId" and d."ownerId"=c."ownerId"
      where c."ownerId"=${session.user.id} and c."workspaceId"=${ref.workspaceId} and c."projectId"=${ref.projectId}
        and d.kind='local' and d."removedAt" is null order by c."deviceId"`)
    return rows
  })
}

export async function writeDeviceCheckout(session: ApiSession, input: z.infer<typeof device>, selectedRoot: string | null) {
  const ref = device.parse(input)
  const selection = selectedRoot === null ? null : root.parse(selectedRoot)
  const owner = session.user.id
  return underProject(session, ref, async app => {
    const owned = await app.execute(sql`select 1 from devices where id=${ref.deviceId} and "ownerId"=${owner}
      and kind='local' and "removedAt" is null for share`)
    if (!owned.rowCount) throw new GovernanceError('not_found')
    if (selection === null) {
      const removed = await app.execute(sql`delete from device_project_checkouts where "ownerId"=${owner} and "workspaceId"=${ref.workspaceId}
        and "projectId"=${ref.projectId} and "deviceId"=${ref.deviceId}`)
      if (removed.rowCount) await deviceCheckoutsChanged(app, owner, ref.workspaceId)
      return null
    }
    const { rows } = await app.execute<DeviceCheckout>(sql`insert into device_project_checkouts
      ("ownerId","workspaceId","projectId","deviceId",root) values (${owner},${ref.workspaceId},${ref.projectId},${ref.deviceId},${selection})
      on conflict ("ownerId","workspaceId","projectId","deviceId") do update set root=excluded.root,
      "updatedAt"=clock_timestamp() where device_project_checkouts.root<>excluded.root
      returning "deviceId","projectId",root,"updatedAt"`)
    if (rows[0]) {
      await deviceCheckoutsChanged(app, owner, ref.workspaceId)
      return rows[0]
    }
    // The no-change conflict already locked this exact row until commit.
    const existing = await app.execute<DeviceCheckout>(sql`select "deviceId","projectId",root,"updatedAt" from device_project_checkouts
      where "ownerId"=${owner} and "workspaceId"=${ref.workspaceId} and "projectId"=${ref.projectId} and "deviceId"=${ref.deviceId}`)
    return existing.rows[0]
  })
}

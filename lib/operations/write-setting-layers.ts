import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'

/** The workspace's write settings for this Coordinator or Bot. Identity comes from the host, never a tool argument. There is no agent/Bot layer: the Bot only names the workspace it belongs to. */
export async function readWriteSettingLayers(executor: Pick<typeof db, 'execute'>, userId: string, botId: string | null) {
  if (!botId) return null
  const { rows } = await executor.execute(sql`select w.external_write_permissions as workspace from bots b left join workspace_computer_policies w on w."workspaceId" = b."workspaceId" where b.id=${botId} and b."ownerId"=${userId}`)
  return (rows[0] as { workspace: unknown } | undefined) ?? null
}

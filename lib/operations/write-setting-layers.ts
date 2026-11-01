import { sql } from 'drizzle-orm'
import type { db } from '@/lib/db'

/** The person's (agent) and workspace write settings for this Coordinator or Bot. Identity comes from the host, never a tool argument. */
export async function readWriteSettingLayers(executor: Pick<typeof db, 'execute'>, userId: string, botId: string | null) {
  const { rows } = await executor.execute(sql`select h.external_write_permissions as agent, w.external_write_permissions as workspace from agent_kit_heads h left join workspace_computer_policies w on w."workspaceId" = h.workspace_id where h.owner_id=${userId} and h.bot_key=${botId ?? 'coordinator'}`)
  return (rows[0] as { agent: unknown; workspace: unknown } | undefined) ?? null
}

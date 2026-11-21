import { withRequestLog } from '@/lib/request-log'
import { pluginActor } from '@/lib/plugins/actor'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { shareSkillSchema, WorkspaceSkillStore } from '@/lib/plugins/workspace-skill'

export const POST = withRequestLog('/api/skills/share', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  // Construct inside the handler so importing this route needs no pool.
  const { pool } = await import('@/lib/db')
  return await new WorkspaceSkillStore(pool).share(userId, await pluginBody(request, shareSkillSchema))
}))

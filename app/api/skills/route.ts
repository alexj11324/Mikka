import { withRequestLog } from '@/lib/request-log'
import { pluginActor } from '@/lib/plugins/actor'
import { deletePluginSchema, installSkillSchema, updateSkillSchema } from '@/lib/plugins/contracts'
import { pluginBody, pluginResponse } from '@/lib/plugins/http'
import { personalPlugins } from '@/lib/plugins/runtime'
import { fetchSkillSource } from '@/lib/plugins/skill-source'

export const GET = withRequestLog('/api/skills', request => pluginResponse(async () => {
  const skills = await personalPlugins.listSkills(await pluginActor(request))
  return { skills, count: skills.length, scope: 'personal' }
}))
export const POST = withRequestLog('/api/skills', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  const input = await pluginBody(request, installSkillSchema)
  const existing = (await personalPlugins.listSkills(userId)).find(skill => skill.source.toLowerCase() === input.source.toLowerCase() && skill.slug === input.slug)
  return { skill: existing ?? await personalPlugins.installSkill(userId, await fetchSkillSource(input)) }
}, 201))
export const PATCH = withRequestLog('/api/skills', request => pluginResponse(async () => {
  const userId = await pluginActor(request), input = await pluginBody(request, updateSkillSchema)
  return { skill: await personalPlugins.updateSkill(userId, input.id, input.enabled) }
}))
export const DELETE = withRequestLog('/api/skills', request => pluginResponse(async () => {
  const userId = await pluginActor(request)
  await personalPlugins.deleteSkill(userId, (await pluginBody(request, deletePluginSchema)).id)
  return { deleted: true }
}))

import { defineDynamic, defineSkill } from 'eve/skills'
import { executionForSession } from '../../../../lib/eve/runtime'

export default defineDynamic(async ctx => {
  const { execution } = await executionForSession(ctx)
  const assigned = execution?.snapshot.definition.skills ?? []
  const personal = execution?.snapshot.personalPlugins?.skills ?? []
  return Object.fromEntries([...assigned, ...personal].map(skill => [skill.id.replace(/[^a-zA-Z0-9_-]/g, '_'), defineSkill({
    description: skill.name, content: skill.body, deferred: true,
  })]))
})

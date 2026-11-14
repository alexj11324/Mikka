import {evaluationBindingId} from '../../../../lib/eve/evaluation-context'
import { defineDynamic, defineSkill } from 'eve/skills'
import { turnPolicy } from '../../../../lib/eve/runtime'

export default defineDynamic(async ctx => {
  if(evaluationBindingId(ctx.session.auth.current))return null
  const policy = turnPolicy.get()
  const assigned = policy?.definition.skills ?? []
  const personal = policy?.personalPlugins?.skills ?? []
  return Object.fromEntries([...assigned, ...personal].map(skill => [skill.id.replace(/[^a-zA-Z0-9_-]/g, '_'), defineSkill({
    description: skill.name, content: skill.body, deferred: true,
  })]))
})

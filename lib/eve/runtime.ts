import type { DynamicModelContext } from 'eve'
import { HostedWorkflowModel } from '../abuse/workflow-model'

export async function modelForSession(ctx: DynamicModelContext) {
  const caller = ctx.session.auth.current
  if (!caller || caller.authenticator !== 'mikka') throw new Error('authRequired')
  return new HostedWorkflowModel(caller.principalId, null, 'deepseek/deepseek-v4.1-flash')
}

export async function instructionsForSession(_ctx: DynamicModelContext) {
  return 'You are Mikka. Use only the tools authorized for this conversation.'
}

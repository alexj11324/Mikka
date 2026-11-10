'use server'

import type { z } from 'zod'
import { runAction } from '@/lib/action-error'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { resourceReferenceInput,resourceAccessChangeSchema } from '@/lib/resource-access/input'
import { resourceAccessView } from '@/lib/resource-access/view'
import { changeResourceAccess } from '@/lib/resource-access/store'
import type { ResourceReference } from '@/lib/resource-access/contract'
import { threadExecutionGrantInput } from '@/lib/resource-access/input'
import { grantThreadExecution,revokeThreadExecution } from '@/lib/collaboration-run-authority'
import { threadExecutionView } from '@/lib/thread-execution-view'

export async function getResourceAccess(reference:ResourceReference) {
  resourceReferenceInput.parse(reference)
  const actor = await currentWorkspaceActor(reference.workspaceId)
  return resourceAccessView(actor.reader,reference)
}

export async function saveResourceAccess(reference:ResourceReference,input:z.input<typeof resourceAccessChangeSchema>) {
  return runAction(async()=>{
    resourceReferenceInput.parse(reference)
    const actor = await currentWorkspaceActor(reference.workspaceId)
    await changeResourceAccess(actor.reader,reference,input)
    return { access:await resourceAccessView(actor.reader,reference) }
  })
}

export async function getThreadExecutionAccess(threadId:string,workspaceId:string) {
  const actor=await currentWorkspaceActor(workspaceId)
  return threadExecutionView(actor.reader,threadId)
}
export async function saveThreadExecutionGrant(threadId:string,workspaceId:string,input:z.input<typeof threadExecutionGrantInput>) {
  return runAction(async()=>{
    const actor=await currentWorkspaceActor(workspaceId)
    await grantThreadExecution(actor.reader,threadId,input)
    return {execution:await threadExecutionView(actor.reader,threadId)}
  })
}
export async function revokeThreadExecutionGrant(threadId:string,workspaceId:string,grantId:string) {
  return runAction(async()=>{
    const actor=await currentWorkspaceActor(workspaceId)
    await revokeThreadExecution(actor.reader,threadId,grantId)
    return {execution:await threadExecutionView(actor.reader,threadId)}
  })
}

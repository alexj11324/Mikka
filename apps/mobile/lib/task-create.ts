import { Client } from 'eve/client'
import { api, type ApiConnection } from './api'
import { eveClientOptions } from './eve-client'
import { acceptTaskDelivery, backlogTaskDraft } from '../../../lib/task-create-form'
import { DESKTOP_RPC_VERSION } from '../../../lib/desktop-rpc/wire'
import type { CreateOnlyCommand, DispatchReceiptInput, DispatchedTaskReceipt } from '../../../lib/task-create-command'

export type TaskCreationIntent = 'create_only' | 'create_and_dispatch'
export type TaskDraft = { intent: TaskCreationIntent; workspaceId: string; title: string; description: string }
type Command = ['issues.createTaskOnly', CreateOnlyCommand] | ['issues.getDispatchedTaskReceipt', DispatchReceiptInput]

async function taskAction<T>([action, input]: Command, connection: ApiConnection) {
  const response = await api<{ ok: true; result: T }>('/api/rpc', {
    method: 'POST', body: { version: DESKTOP_RPC_VERSION, action, args: [input] },
  }, connection)
  return response.result
}

export async function submitMobileTask(draft: TaskDraft, operation: { id: string; delivered?: true }, connection: ApiConnection) {
  const { workspaceId, title, description } = draft
  if (draft.intent === 'create_only') {
    const result = await taskAction<{ taskId: string } | { error: string }>(['issues.createTaskOnly', {
      version: 1, intent: 'create_only', workspaceId, requestId: operation.id, ...backlogTaskDraft(title, description),
    }], connection)
    if ('error' in result) throw new Error(result.error)
    return result.taskId
  }
  await acceptTaskDelivery(operation, async id => {
    const client = new Client(eveClientOptions(null, connection))
    const { session } = await client.sessions.create()
    await session.send(description, {
      headers: { 'x-mikka-submission-id': id },
      clientContext: { expectedWorkspaceId: workspaceId, botId: null, ...(title ? { taskTitle: title } : {}),
        taskCommand: { version: 1, intent: 'create_and_dispatch', description } },
    })
  })
  const receipt = await taskAction<DispatchedTaskReceipt | null>(['issues.getDispatchedTaskReceipt', { workspaceId, botId: null, requestId: operation.id }], connection)
  if (!receipt) throw new Error('receiptUnavailable')
  return receipt.taskId
}

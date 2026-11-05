import { factoryFlowVersion, type FactoryBinding } from './contract'
import { factoryBinding } from './dispatch'
import type { FactoryTask } from './store'

export interface FactoryActionReceipt {
  contractVersion: 2
  binding: FactoryBinding
  runId?: string
  replayed?: boolean
  readTask: { tool: 'get_factory_task'; input: { taskId: string } }
}

/**
 * Present an already-committed v2 action, without a second state or a post-commit
 * read that could fail after success. Replays use only the durable receipt.
 * Non-snapshots (including pending/refusal results) and v1 results stay exact.
 */
export function publicFactoryReceipt<T>(result: T): T | FactoryActionReceipt {
  if (!result || typeof result !== 'object' || !('contractVersion' in result) || result.contractVersion !== 1 ||
    !('task' in result) || !result.task || typeof result.task !== 'object' || factoryFlowVersion(result.task) !== 2) return result
  const task = result.task as FactoryTask
  return { contractVersion: 2, binding: factoryBinding(task),
    ...('runId' in result && typeof result.runId === 'string' ? { runId: result.runId } : {}),
    ...('replayed' in result && typeof result.replayed === 'boolean' ? { replayed: result.replayed } : {}),
    readTask: { tool: 'get_factory_task', input: { taskId: task.id } } }
}

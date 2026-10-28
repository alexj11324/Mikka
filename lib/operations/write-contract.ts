import { createHash } from 'node:crypto'
import type { OperationReceipt } from './ledger'
import type { WriteActionName } from './write-schema'
export { WRITE_ACTIONS,writeSchemas,parseWriteInput,type WriteActionName } from './write-schema'

export function writeTarget(action: WriteActionName, input: Record<string, unknown>) {
  const id = action === 'append_notion_paragraph' ? input.page_id : action === 'send_slack_message' ? input.channel : input.event_id
  return `${action}:${createHash('sha256').update(JSON.stringify(id)).digest('hex')}`
}
export interface WriteProvider {
  name: string
  /** Must resolve exactly one active owner account, pin version, and read/check target
   * access with that account. A connection or target string is never authority. */
  prepare(ownerId: string, payload: Record<string, unknown>): Promise<{ accountId: string; version: string; context?: Record<string, unknown> | null }>
  execute(input: { ownerId: string; accountId: string; version: string; payload: Record<string, unknown>; approvalContext: Record<string, unknown> | null; idempotencyKey: string; signal: AbortSignal; beforeSend: () => Promise<void> }): Promise<OperationReceipt>
  lookup(input: { ownerId: string; accountId: string; idempotencyKey: string }): Promise<OperationReceipt | null>
}

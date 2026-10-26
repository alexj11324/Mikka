import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { OperationReceipt } from './ledger'

export const WRITE_ACTIONS = ['append_notion_paragraph', 'send_slack_message', 'cancel_calendar_event'] as const
export type WriteActionName = typeof WRITE_ACTIONS[number]
export const writeSchemas = {
  append_notion_paragraph: z.object({ page_id: z.uuid(), text: z.string().trim().min(1).max(2000) }).strict(),
  send_slack_message: z.object({ channel: z.string().regex(/^[CG][A-Z0-9]{8,30}$/), text: z.string().trim().min(1).max(3000) }).strict(),
  cancel_calendar_event: z.object({ event_id: z.string().trim().min(1).max(1024), send_updates: z.enum(['none', 'all']) }).strict(),
}
export function parseWriteInput(action: WriteActionName, raw: unknown): Record<string, unknown> | null {
  const schema = Object.hasOwn(writeSchemas, action) ? writeSchemas[action] : null
  const result = schema?.safeParse(raw)
  return result?.success ? result.data : null
}
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

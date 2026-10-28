import { z } from 'zod'

/** Workflow-safe content schemas. None of these arguments select authority. */
export const WRITE_ACTIONS = ['append_notion_paragraph', 'send_slack_message', 'cancel_calendar_event'] as const
export type WriteActionName = typeof WRITE_ACTIONS[number]
export const writeSchemas = {
  append_notion_paragraph: z.object({ page_id: z.uuid(), text: z.string().trim().min(1).max(2000) }).strict(),
  send_slack_message: z.object({ channel: z.string().regex(/^[CG][A-Z0-9]{8,30}$/), text: z.string().trim().min(1).max(3000) }).strict(),
  cancel_calendar_event: z.object({ event_id: z.string().trim().min(1).max(1024), send_updates: z.enum(['none', 'all']) }).strict(),
}
export const writeBatchSchema = z.object({ actions: z.array(z.discriminatedUnion('action',[
  z.object({action:z.literal('append_notion_paragraph'),input:writeSchemas.append_notion_paragraph}).strict(),
  z.object({action:z.literal('send_slack_message'),input:writeSchemas.send_slack_message}).strict(),
  z.object({action:z.literal('cancel_calendar_event'),input:writeSchemas.cancel_calendar_event}).strict(),
])).min(1).max(20) }).strict()
export const PERSONAL_WRITE_TOOL_IDS = [...WRITE_ACTIONS,'propose_personal_writes'] as const
export type PersonalWriteToolId = typeof PERSONAL_WRITE_TOOL_IDS[number]
export interface PersonalWriteContext { sourceEventId: string; holder: string; work?: {id:string;fence:number} }

export function parseWriteInput(action: WriteActionName, raw: unknown): Record<string, unknown> | null {
  const schema = Object.hasOwn(writeSchemas, action) ? writeSchemas[action] : null
  const result = schema?.safeParse(raw)
  return result?.success ? result.data : null
}

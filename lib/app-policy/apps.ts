// Apps a workspace can allow or block for its bots (N4 允许使用的应用). Pure: shared by UI, store and tests.
// GitHub and Linear are not here: bots do not reach them through a per-app tool, so a switch would do nothing.
import { z } from 'zod'

export const POLICY_APPS = ['gmail', 'googlecalendar', 'slack', 'notion'] as const
export type PolicyApp = (typeof POLICY_APPS)[number]
export const APP_ACCESS = ['allow', 'deny'] as const
export type AppAccess = (typeof APP_ACCESS)[number]

export const setAppPolicyInput = z.object({ app: z.enum(POLICY_APPS), access: z.enum(APP_ACCESS) }).strict()

/** The personal write tools (lib/operations/model-write-tools) and the app each one writes to. */
export const WRITE_TOOL_APPS: Record<string, PolicyApp> = {
  append_notion_paragraph: 'notion',
  send_slack_message: 'slack',
  cancel_calendar_event: 'googlecalendar',
}

export const isPolicyApp = (value: string): value is PolicyApp => (POLICY_APPS as readonly string[]).includes(value)

/** What a blocked tool call returns to the model: a plain error code, as other tool failures do. */
export const APP_BLOCKED = { error: 'integrationBlockedByWorkspace' } as const

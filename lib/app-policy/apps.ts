// Apps a workspace can allow or block for its bots (N4 允许使用的应用). Pure: shared by UI, store and tests.
// GitHub and Linear are not here: bots do not reach them through a per-app tool, so a switch would do nothing.
import { z } from 'zod'
import { TOOLKIT_SLUG } from '@/lib/composio-accounts'

export const POLICY_APPS = ['gmail', 'googlecalendar', 'slack', 'notion'] as const
export type PolicyApp = (typeof POLICY_APPS)[number]
/** Backend catalog may expand before the settings page adopts its new rows. */
export const POLICY_TOOLKIT_IDS = [...POLICY_APPS, 'googledrive'] as const
export type PolicyToolkitId = (typeof POLICY_TOOLKIT_IDS)[number]
export const APP_ACCESS = ['allow', 'deny'] as const
export type AppAccess = (typeof APP_ACCESS)[number]

/** Any store app can be turned off for a workspace's bots, not only the rows the settings page lists. */
export const setAppPolicyInput = z.object({ app: z.string().regex(TOOLKIT_SLUG), access: z.enum(APP_ACCESS) }).strict()

/** The personal write tools (lib/operations/model-write-tools) and the app each one writes to. */
export const WRITE_TOOL_APPS: Record<string, PolicyApp> = {
  append_notion_paragraph: 'notion',
  send_slack_message: 'slack',
  cancel_calendar_event: 'googlecalendar',
}

export const isPolicyApp = (value: string): value is PolicyToolkitId => (POLICY_TOOLKIT_IDS as readonly string[]).includes(value)

/** What a blocked tool call returns to the model: a plain error code, as other tool failures do. */
export const APP_BLOCKED = { error: 'integrationBlockedByWorkspace' } as const

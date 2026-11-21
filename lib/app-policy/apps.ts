// Apps a workspace can allow or block for its bots (N4 允许使用的应用). Pure: shared by UI, store and tests.
// Any Composio toolkit can be governed; which apps exist is Composio's live list, not a list here.
// GitHub, Linear and Telegram are not: bots do not reach them through a per-app tool, so a switch would do nothing.
import { z } from 'zod'
import { isComposioToolkitSlug, TOOLKIT_SLUG } from '@/lib/composio-accounts'

/** A Composio toolkit slug (gmail, hubspot, googlesheets…). */
export type PolicyApp = string
export const APP_ACCESS = ['allow', 'deny'] as const
export type AppAccess = (typeof APP_ACCESS)[number]

/** Any store app can be turned off for a workspace's bots, not only the rows the settings page lists. */
export const setAppPolicyInput = z.object({ app: z.string().regex(TOOLKIT_SLUG).refine(isComposioToolkitSlug), access: z.enum(APP_ACCESS) }).strict()

/**
 * The rows 允许使用的应用 lists: every app with a stored choice plus every app an active member connected (live from
 * Composio), each once, by slug; no stored choice means 允许.
 */
export function policyRows(stored: ReadonlyMap<string, AppAccess>, connected: readonly string[]): Array<{ app: PolicyApp; access: AppAccess }> {
  const apps = new Set([...stored.keys(), ...connected].filter(isComposioToolkitSlug))
  return [...apps].sort().map(app => ({ app, access: stored.get(app) ?? 'allow' }))
}

/** The personal write tools (lib/operations/model-write-tools) and the app each one writes to. */
export const WRITE_TOOL_APPS: Readonly<Record<string, string>> = {
  append_notion_paragraph: 'notion',
  send_slack_message: 'slack',
  cancel_calendar_event: 'googlecalendar',
}

/** What a blocked tool call returns to the model: a plain error code, as other tool failures do. */
export const APP_BLOCKED = { error: 'integrationBlockedByWorkspace' } as const

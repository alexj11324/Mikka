import { appCallSetting, toolSettingKey, type AppToolDecision } from '@/lib/app-tools'
import { COMPOSIO_ACTIONS, type ApprovalActionName } from '@/lib/composio-actions'
import type { db } from '@/lib/db'
import { readWriteSettingLayers } from './write-setting-layers'

/** The workspace's one explicit setting for a first-class mail or calendar
 * write, read through the Bot's workspace. Null when no key names the call;
 * an unreadable layer throws so the caller fails closed. */
export async function accountWriteSetting(
  executor: Pick<typeof db, 'execute'>, userId: string, botId: string | null, action: ApprovalActionName,
): Promise<AppToolDecision | null> {
  return await workspaceWriteSetting(executor, userId, botId, action, COMPOSIO_ACTIONS[action].toolkit)
}

/** The same setting for a store-app tool call (one card or one direct call). */
export async function appToolWriteSetting(
  executor: Pick<typeof db, 'execute'>, userId: string, botId: string | null, tool: string, toolkit: string,
): Promise<AppToolDecision | null> {
  return await workspaceWriteSetting(executor, userId, botId, tool, toolkit)
}

async function workspaceWriteSetting(
  executor: Pick<typeof db, 'execute'>, userId: string, botId: string | null, tool: string, toolkit: string,
): Promise<AppToolDecision | null> {
  return appCallSetting(await readWriteSettingLayers(executor, userId, botId), toolSettingKey(tool), toolkit)
}

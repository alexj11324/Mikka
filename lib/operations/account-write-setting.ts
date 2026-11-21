import { appCallSetting, toolSettingKey, type AppToolDecision } from '@/lib/app-tools'
import { COMPOSIO_ACTIONS, type ApprovalActionName } from '@/lib/composio-actions'
import type { db } from '@/lib/db'
import { readWriteSettingLayers } from './write-setting-layers'

/** The workspace's one explicit setting for a first-class mail or calendar write, read through the Bot's workspace. */
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

/**
 * A layer that cannot be read names nothing, so the call goes to the Decisions
 * judge exactly as an unset key does, and the diagnostic is logged by name
 * (decision 2026-11-01-1330: unreadable settings leave the call to the judge).
 * This is deliberately not a refusal — see the note in
 * `lib/operations/write-judgment.ts` — and it is logged so an unreadable
 * workspace is visible without failing the person's write.
 */
async function workspaceWriteSetting(
  executor: Pick<typeof db, 'execute'>, userId: string, botId: string | null, tool: string, toolkit: string,
): Promise<AppToolDecision | null> {
  let layers: { workspace: unknown } | null
  try {
    layers = await readWriteSettingLayers(executor, userId, botId)
  } catch (failure) {
    console.error('Workspace write setting unreadable: judged without it', { toolkit, tool: toolSettingKey(tool), cause: failure instanceof Error ? failure.name : 'unknown' })
    return null
  }
  try {
    return appCallSetting(layers, toolSettingKey(tool), toolkit)
  } catch (failure) {
    // A stored layer that does not parse is unreadable in the same way.
    console.error('Workspace write setting malformed: judged without it', { toolkit, tool: toolSettingKey(tool), cause: failure instanceof Error ? failure.name : 'unknown' })
    return null
  }
}

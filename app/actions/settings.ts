'use server'

import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { readSettings, resetSettings, writeSettings } from '@/lib/settings/store'
import { settingsSchema } from '@/lib/settings/registry'
import { requireUser } from '@/lib/issue-access'

export async function getSettings(workspaceId?: string) {
  return settingsWorkspaceAction(async () => readSettings(await currentWorkspaceActor(workspaceId)))
}
export async function getWorkspaceSettings(workspaceId: string) {
  return settingsWorkspaceAction(async () => readSettings(await currentWorkspaceActor(workspaceId), 'workspace'))
}
export async function patchPersonalSettings(raw: unknown, workspaceId?: string) {
  return settingsWorkspaceAction(async () => writeSettings(await currentWorkspaceActor(workspaceId), 'personal', raw))
}
export async function patchWorkspaceSettings(workspaceId: string, raw: unknown) {
  return settingsWorkspaceAction(async () => writeSettings(await currentWorkspaceActor(workspaceId), 'workspace', raw))
}
export async function resetPersonalSettings(raw: unknown, workspaceId?: string) {
  return settingsWorkspaceAction(async () => resetSettings(await currentWorkspaceActor(workspaceId), 'personal', raw))
}
export async function resetWorkspaceSettings(workspaceId: string, raw: unknown) {
  return settingsWorkspaceAction(async () => resetSettings(await currentWorkspaceActor(workspaceId), 'workspace', raw))
}
export async function getSettingsSchema() {
  return settingsWorkspaceAction(async () => { await requireUser(); return { settings: settingsSchema() } })
}

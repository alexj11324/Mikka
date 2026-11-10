import 'server-only'
import { db } from '@/lib/db'
import { explicitSetting } from '@/lib/app-tools'
import { appCallAllowed } from './app-permission-keys'
import { readWriteSettingLayers } from './write-setting-layers'

type SettingLayers = { agent: unknown; workspace: unknown } | null

/** The layers are injectable so a database error and malformed stored settings are testable. */
export type GitHubCallPolicyDeps = {
  layers?: (userId: string, botId: string | null) => Promise<SettingLayers>
}

/** GitHub tools act with the person's own credential; an app-level deny blocks a call.
 * `github_tools` still lists names so the model can explain why it cannot act.
 * Settings that cannot be read fail closed: a database error or malformed stored
 * layer must never turn an explicit deny into an allow. */
export async function githubCallAllowed(userId: string, botId: string | null, deps: GitHubCallPolicyDeps = {}): Promise<boolean> {
  try {
    const layers = await (deps.layers ?? ((owner, bot) => readWriteSettingLayers(db, owner, bot)))(userId, botId)
    return appCallAllowed(explicitSetting(layers, ['github']))
  } catch {
    return false
  }
}

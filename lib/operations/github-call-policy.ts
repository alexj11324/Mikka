import 'server-only'
import { db } from '@/lib/db'
import { explicitSetting } from '@/lib/app-tools'
import { appCallAllowed } from './app-permission-keys'
import { readWriteSettingLayers } from './write-setting-layers'

/** GitHub tools act with the person's own credential; an app-level deny blocks a call.
 * `github_tools` still lists names so the model can explain why it cannot act. */
export async function githubCallAllowed(userId: string, botId: string | null): Promise<boolean> {
  try {
    return appCallAllowed(explicitSetting(await readWriteSettingLayers(db, userId, botId), ['github']))
  } catch {
    // Unreadable settings name nothing; keep the existing direct-call path.
    return true
  }
}

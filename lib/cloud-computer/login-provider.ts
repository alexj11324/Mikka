import 'server-only'
import { login } from '../credentials/runtime'

/** #342's workflow calls this before requesting a login card. Caller identity
 * comes from its persisted owner-bound subagent, never model input. */
export async function requestBrowserLogin(caller: { userId: string; workspaceId: string; botId: string; subagentId: string }, site: string) {
  return login(caller, site)
}

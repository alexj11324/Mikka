import 'server-only'
import type { BrowserCaller } from '../credentials/contracts'
import type { BrowserTarget } from '../credentials/store'

/** Integration seam owned by #342. Replace with that PR's fenced gateway
 * implementation when merging the two PRs. Never fall back to an unfenced CDP. */
export async function resolveSubagentBrowserTarget(_caller: BrowserCaller): Promise<BrowserTarget> {
  throw new Error('Subagent browser runtime is not installed (#342)')
}

export async function resolveThreadBrowserTarget(_caller: { userId: string; workspaceId: string; runId: string }): Promise<BrowserTarget> {
  throw new Error('Thread browser runtime is not installed (#342)')
}

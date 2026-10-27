import 'server-only'
export type BrowserLoginResult = { status: 'needs_login' | 'submitted' | 'needs_code'; origin?: string }
/** #180 replaces this dependency seam with its server-side login service.
 * This branch alone never opens a second vault or handles a plaintext secret. */
export async function requestBrowserLogin(_caller: { userId: string; workspaceId: string; botId: string; subagentId: string }, _site: string): Promise<BrowserLoginResult> {
  return { status: 'needs_login' }
}

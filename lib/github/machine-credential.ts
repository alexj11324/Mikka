import 'server-only'
import { cloudGitHubCredential, useCloudGitHub } from './cloud'
import { githubTokenForUser } from './user-access'
import { linkedGitHubAccountId } from './repository-installation'

export async function githubMachineConfigured(userId: string): Promise<boolean> {
  return await useCloudGitHub(userId) || Boolean(await linkedGitHubAccountId(userId))
}

/** Self-owned App → explicitly linked cloud capability → legacy environment OAuth.
 * The cloud branch returns a native installation token, with its installation authority explicit. */
export async function githubMachineCredential(userId: string, options: { remoteKey?: string; minValidityMs?: number } = {}): Promise<{ token: string; expiresAt: Date | null; githubAccountId?: string; installationId?: string }> {
  const cloud = await cloudGitHubCredential(userId, options.remoteKey)
  return cloud ?? githubTokenForUser(userId, options)
}

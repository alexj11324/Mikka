import type { GithubProfile } from '@better-auth/core/social-providers'

// Only GitHub's authenticated, verified primary mailbox may participate in
// automatic same-email linking. A public profile email is not ownership proof.
export function githubVerifiedProfile(request: typeof fetch = fetch) {
  return async (token: { accessToken?: string }) => {
    if (!token.accessToken) return null
    const get = async (path: string) => {
      const response = await request(`https://api.github.com${path}`, {
        headers: { authorization: `Bearer ${token.accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'Mikka' },
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) { await response.body?.cancel(); return null }
      return response.json() as Promise<unknown>
    }
    try {
      const profile = await get('/user')
      const emails = await get('/user/emails')
      if (!profile || typeof profile !== 'object' || !('id' in profile) || !Number.isSafeInteger(profile.id) || Number(profile.id) <= 0 || !Array.isArray(emails)) return null
      const primary = emails.filter(item => item && item.primary === true)
      if (primary.length !== 1 || primary[0].verified !== true || typeof primary[0].email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(primary[0].email)) return null
      const email: string = primary[0].email.toLowerCase()
      const data = profile as Record<string, unknown>
      return {
        user: { email, emailVerified: true, name: typeof data.name === 'string' ? data.name : typeof data.login === 'string' ? data.login : '', image: typeof data.avatar_url === 'string' ? data.avatar_url : undefined },
        // Only id and email participate in binding; both are validated above.
        data: { ...data, id: profile.id as number, email } as unknown as GithubProfile,
      }
    } catch { return null }
  }
}

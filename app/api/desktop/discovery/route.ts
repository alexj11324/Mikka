import { desktopDiscoveryResponse } from '@/lib/desktop-discovery'
import { withRequestLog } from '@/lib/request-log'
import { authSignInMethods } from '@/lib/auth-config'

export const dynamic = 'force-dynamic'

/** Called before sign-in. The fixed /mikka mount is declared in the response;
 * desktop clients probing a bare origin retry this mount without redirects. */
export const GET = withRequestLog('/api/desktop/discovery', async (request: Request) => {
  const signIn = authSignInMethods(process.env)
  if (process.env.GITHUB_SIGN_IN_USE_APP === 'true') {
    // Manifest-managed credentials are optional. Ordinary discovery does not
    // initialize Better Auth or query the credential store.
    const { githubSignInEnabled } = await import('@/lib/auth')
    signIn.github = await githubSignInEnabled()
  }
  return desktopDiscoveryResponse(request, process.env, signIn)
})

import { githubAppManifestRoutes } from '@/lib/github/manifest-runtime'
import { freshSessionRoute } from '@/lib/fresh-session'
import { withRequestLog } from '@/lib/request-log'

export const GET = freshSessionRoute(withRequestLog('/api/github/manifest/callback', githubAppManifestRoutes.callback))

import { freshSessionRoute } from '@/lib/fresh-session'
import { savedCredentialsRoute } from '@/lib/credentials/route'
export const GET = savedCredentialsRoute
const DELETEBody = savedCredentialsRoute

// Credentials, permissions, money and deletion: the session is read from the database, not the cookie cache.
export const DELETE = freshSessionRoute(DELETEBody)

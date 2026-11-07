import { humanSessionHeaders } from '@/lib/desktop-rpc/handler'
import { auth } from '@/lib/api-auth'
import { noteLogUser } from '@/lib/request-log'
import { PluginError } from './contracts'

export async function pluginActor(request: Request, options: { humanOnly?: boolean } = {}) {
  const headers = options.humanOnly ? humanSessionHeaders(request) : request.headers
  if (!headers) throw new PluginError('authRequired', 401)
  const session = await auth.api.getSession({ headers, ...(options.humanOnly ? { query: { disableCookieCache: true } } : {}) })
  noteLogUser(session?.user?.id)
  if (!session?.user) throw new PluginError('authRequired', 401)
  if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) throw new PluginError('originNotAllowed', 403)
  return session.user.id
}

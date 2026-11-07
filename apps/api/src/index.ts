import { routes } from '../generated/routes'
import { beginRequestTrace } from '../runtime/request-trace'
import { createApiHandler } from './application'
import { createWebTransport } from '../../../lib/web-connection/transport'

// Generated imports are lazy. The outer runtime initializes tracing before
// importing this module, so no business handler/pg loads before instrumentation.
export default createApiHandler(routes, beginRequestTrace, createWebTransport({
  authenticate: async headers => {
    const { auth } = await import('../../../lib/auth')
    return auth.api.getSession({ headers, query: { disableCookieCache: true } })
  },
  // Handlers retain their normal authentication/RPC scope. Supplying only a
  // verified identity here must not synthesize Better Auth returnHeaders modes.
  scope: (_identity, work) => work(),
}))

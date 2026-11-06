import { definePlugin } from 'nitro'
import { resolveAppOrigin } from '../../../lib/auth-config'
import { withVercelRequestAuthority } from '../runtime/request-authority'

/** Loaded only for the Vercel production preset. Ordinary Node, Docker and Vite
 * retain their existing explicit ingress owners and local origins. */
export default definePlugin(application => {
  application.fetch = withVercelRequestAuthority(application.fetch, {
    origin: resolveAppOrigin(process.env),
    deploymentHost: process.env.VERCEL_URL,
    productionHost: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  })
})

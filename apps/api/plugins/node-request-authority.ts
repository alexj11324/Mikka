import { definePlugin } from 'nitro'
import { resolveAppOrigin } from '../../../lib/auth-config'
import { withNodeRequestAuthority } from '../runtime/request-authority'

export default definePlugin(application => {
  application.fetch = withNodeRequestAuthority(application.fetch, {
    origin: resolveAppOrigin(process.env),
    legacyHost: process.env.MIKKA_LEGACY_APP_HOST,
  })
})

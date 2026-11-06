import { definePlugin } from 'nitro'
import { applySecurityHeaders } from '../runtime/http-policy.mjs'

export default definePlugin(application => {
  const fetch = application.fetch
  application.fetch = async request => applySecurityHeaders(request, await fetch(request))
})

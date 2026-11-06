import { defineHandler } from 'nitro'
import api from '../src/index'
import { spaHtml } from '../generated/spa'
import { isMachinePath, pageRedirect, pageResponse, applySecurityHeaders } from './http-policy.mjs'

export default defineHandler(async event => {
  const request = event.req
  const redirect = pageRedirect(request)
  if (redirect) return applySecurityHeaders(request, redirect)
  // Pass the original SDK request through: its node req/res, abort signal and
  // waitUntil own stream disposal and after work. Never reconstruct a Request.
  if (isMachinePath(new URL(request.url).pathname)) return api.fetch(request)
  return pageResponse(request, () => spaHtml)
})

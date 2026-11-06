import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMachinePath, pageResponse } from '../runtime/http-policy.mjs'

export function apiProxyOptions(target) {
  const url = new URL(target)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('API_DEV_PROXY_TARGET_INVALID')
  return { '^/': { target: url.origin, changeOrigin: false, ws: false,
    bypass: request => isMachinePath(new URL(request.url, 'http://local.invalid').pathname) ? undefined : request.url } }
}

export function developmentRequest(incoming, origin) {
  const raw = incoming.rawHeaders, hosts = []
  for (let index = 0; index < raw.length; index += 2) if (raw[index].toLowerCase() === 'host') hosts.push(raw[index + 1])
  if (hosts.length !== 1 || !/^[a-zA-Z0-9.:[\]-]+$/.test(hosts[0])) throw new Error('API_DEV_HOST_INVALID')
  const known = new URL(origin), host = hosts[0]
  const protocol = host === known.host ? known.protocol : 'http:'
  const target = incoming.originalUrl ?? incoming.url
  if (!target?.startsWith('/') || target.startsWith('//')) throw new Error('API_DEV_REQUEST_TARGET_INVALID')
  const headers = new Headers()
  for (let index = 0; index < raw.length; index += 2) headers.append(raw[index], raw[index + 1])
  return new Request(`${protocol}//${host}${target}`, { method: incoming.method, headers })
}
export const developmentDocument = (request, render) => pageResponse(request, render, { production: false })

export function developmentPages({ root, origin }) {
  return { name: 'mikka-development-pages', configureServer(server) {
    // Vite checks its slash-terminated base before post middlewares. Preserve the
    // public request while letting its normal Host/CORS and base checks run.
    server.middlewares.use((incoming, _outgoing, next) => {
      const target = incoming.url
      if (target === '/mikka' || target?.startsWith('/mikka?')) {
        incoming.originalUrl ??= target
        incoming.url = `/mikka/${target.slice('/mikka'.length)}`
      }
      next()
    })
    return () => server.middlewares.use(async (incoming, outgoing, next) => {
      try {
        const request = developmentRequest(incoming, origin)
        const path = new URL(request.url).pathname
        if (isMachinePath(path)) return next()
        const response = await developmentDocument(request, async () => server.transformIndexHtml(request.url, await readFile(join(root, 'apps/frontend/index.html'), 'utf8')))
        outgoing.statusCode = response.status
        for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value)
        const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing.setHeader('set-cookie', cookies)
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) { next(error) }
    })
  } }
}

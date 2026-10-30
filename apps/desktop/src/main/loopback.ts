import { createServer, type Server } from 'node:http'

import { desktopAuthFinishUrl, desktopAuthState } from './security'

export interface LoopbackAuthServer {
  callback: string
  close(): void
}

/**
 * A one-shot listener for the OAuth return. It is bound to 127.0.0.1, echoes
 * the nonce the renderer registered, and hands back only the in-app finish
 * URL. The caller owns the lifetime and closes it on timeout or quit.
 */
export async function startLoopbackAuth(options: {
  state: unknown
  appUrl: string
  onFinish: (finishUrl: string) => void
}): Promise<LoopbackAuthServer> {
  const state = desktopAuthState(options.state)
  if (!state) throw new Error('A desktop nonce is required')
  let closed = false
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || requestUrl.pathname !== '/auth/callback') {
      response.writeHead(404, { 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    const code = requestUrl.searchParams.get('code')
    const returnedState = requestUrl.searchParams.get('state')
    const next = requestUrl.searchParams.get('next') ?? '/'
    const finish = returnedState === state ? desktopAuthFinishUrl(code, returnedState, next, options.appUrl) : null
    if (!finish) {
      response.writeHead(400, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('This sign-in link is invalid or expired. Return to Mikka and try again.')
      close()
      return
    }
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'no-referrer' })
    response.end('<!doctype html><meta charset="utf-8"><title>Returning to Mikka</title><p>Returning to Mikka…</p>')
    close()
    options.onFinish(finish)
  })
  function close() {
    if (closed) return
    closed = true
    server.close()
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  }).catch(error => {
    server.close()
    throw error
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('The sign-in listener did not start')
  }
  const callback = `http://127.0.0.1:${address.port}/auth/callback`
  return {
    callback,
    close,
  }
}

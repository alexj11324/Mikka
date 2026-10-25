// Optional browser transport for the registered Claude callback. No account,
// CLI credential file, global operator key or Infisical credential is accessed.
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export function callbackDestination(receiver, raw, host, expectedState) {
  const target = new URL(receiver)
  if (target.protocol !== 'https:' || !/^mikka-[a-z0-9]+-mikka-dev\.vercel\.app$/.test(target.hostname) || target.username || target.password || target.port || target.search || target.hash || target.pathname !== '/mikka/api/subscriptions/enrollments/handoff') throw new Error('relay_destination_refused')
  if (!/^[A-Za-z0-9_-]{43}$/.test(expectedState) || host !== 'localhost:54545' || !raw.startsWith('/callback?') || raw.includes('#') || raw.length > 8192) throw new Error('relay_callback_refused')
  const callback = new URL(raw, 'http://localhost:54545')
  const keys = [...callback.searchParams.keys()]
  if (callback.pathname !== '/callback' || keys.length !== 2 || !keys.includes('code') || !keys.includes('state') || !/^[A-Za-z0-9_-]{43}$/.test(callback.searchParams.get('state')) || !callback.searchParams.get('code') || callback.searchParams.get('state') !== expectedState) throw new Error('relay_callback_refused')
  target.hash = new URLSearchParams({ callbackUrl: callback.href }).toString()
  return target.href
}
export async function startCallbackRelay(receiver, expectedState, lifetime = 600000) {
  // Validate the fixed destination before opening any listener.
  callbackDestination(receiver, `/callback?code=validation&state=${expectedState}`, 'localhost:54545', expectedState)
  const server = createServer((request, response) => {
    const headers = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" }
    try {
      if (request.method !== 'GET') throw new Error()
      const location = callbackDestination(receiver, request.url, request.headers.host, expectedState)
      response.writeHead(303, { ...headers, location }).end()
      server.close() // Release the registered port after this exact ceremony's callback.
    } catch { response.writeHead(400, headers).end('Callback refused') }
  })
  // Bind only the machine's resolved localhost loopback address.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(54545, 'localhost', resolve) })
  const timer = setTimeout(() => server.close(), Math.min(lifetime, 600000)); timer.unref()
  server.once('close', () => clearTimeout(timer))
  return server
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startCallbackRelay(process.argv[2], process.env.MIKKA_BYOS_RELAY_STATE)
    console.log('Mikka callback relay listening on localhost:54545 for at most 10 minutes; callback values are never logged.')
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close())
  } catch { console.error('Mikka callback relay unavailable; no existing process or credential was changed.'); process.exitCode = 1 }
}

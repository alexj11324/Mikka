// Runs only in the isolated trace acceptance runner and its real API workers.
// The existing MVP fence still refuses every other external request.
import './preload.mjs'
import { assertMvpEnvironment } from './isolated-env.mjs'

assertMvpEnvironment()
const underlying = globalThis.fetch
globalThis.fetch = (input, init) => {
  const request = new Request(input, init), url = new URL(request.url)
  if (url.origin === 'https://us.i.posthog.com')
    return underlying(new Request(`http://127.0.0.1:3196${url.pathname}${url.search}`, request), { redirect: 'error' })
  return underlying(request)
}

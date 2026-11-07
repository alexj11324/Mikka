import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'

const require = createRequire('/workspace/scratch/812e3b7d6d45/Mikka/package.json')
const { betterAuth } = await import(require.resolve('better-auth'))
const { memoryAdapter } = await import(require.resolve('better-auth/adapters/memory'))
const { bearer, multiSession, oneTimeToken } = await import(require.resolve('better-auth/plugins'))
const packageVersion = JSON.parse(await readFile('/workspace/scratch/812e3b7d6d45/Mikka/node_modules/better-auth/package.json', 'utf8')).version
const memory = { user: [], session: [], account: [], verification: [] }
const auth = betterAuth({
  baseURL: 'https://isolated-auth.example.test', basePath: '/mikka/api/auth',
  secret: 'synthetic-local-1512-only-auth-secret-at-least-32-characters',
  database: memoryAdapter(memory), emailAndPassword: { enabled: true },
  plugins: [bearer(), multiSession(), oneTimeToken({ expiresIn: 1, storeToken: 'hashed' })],
  logger: { disabled: true },
})
const credentials = { email: 'synthetic-1512@example.test', password: 'synthetic-local-password-1512' }
const jar = new Map()
function remember(headers) {
  for (const cookie of headers.getSetCookie()) {
    const first = cookie.split(';')[0], separator = first.indexOf('=')
    const name = first.slice(0, separator), value = first.slice(separator + 1)
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name)
    else jar.set(name, value)
  }
}
const headers = () => new Headers({ cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') })
const signIn = async () => {
  const result = await auth.api.signInEmail({ body: credentials, headers: headers(), returnHeaders: true })
  remember(result.headers)
  return result.response.token
}
const nativeHandoff = async () => {
  const one = await auth.api.generateOneTimeToken({ headers: headers() })
  return auth.api.verifyOneTimeToken({ body: { token: one.token }, headers: new Headers() })
}
const retained = token => memory.session.some(session => session.token === token)
const freshRead = token => auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }), query: { disableCookieCache: true } })
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN') }
try {
  const signup = await auth.api.signUpEmail({ body: { ...credentials, name: 'Synthetic' }, returnHeaders: true })
  remember(signup.headers)
  const nativeLoginToken = await signIn()
  const native = await nativeHandoff()
  const sharesBrowserSession = native.session.token === nativeLoginToken
  assert.ok(sharesBrowserSession, 'OTT handoff must preserve the original browser session in this real SDK')
  assert.ok(retained(nativeLoginToken), 'native bearer exists before the next same-jar login')
  const webLoginToken = await signIn()
  const oldNativeRetained = retained(nativeLoginToken)
  const oldNativeReadable = Boolean(await freshRead(nativeLoginToken))
  assert.ok(!oldNativeRetained && !oldNativeReadable, 'same-jar Web login revokes the earlier native session')
  assert.ok(retained(webLoginToken), 'new Web session remains valid')
  // Reordered setup: the short Web context ends first; native and hosted then
  // retain the last ordinary login for every unchanged lifecycle assertion.
  const finalNativeToken = await signIn()
  const finalNative = await nativeHandoff()
  assert.ok(finalNative.session.token === finalNativeToken, 'final native handoff stays on the latest ordinary login')
  assert.ok(await freshRead(finalNativeToken), 'a later fresh-process bearer check still succeeds without another login')
  const receipt = {
    source: 'real_installed_better_auth_with_memory_adapter', version: packageVersion,
    productionRequests: 0, externalRequests: 0, databaseConnections: 0,
    oldOrder: { nativeHandoffSharesBrowserSession: sharesBrowserSession, subsequentWebLoginRevokesNative: !oldNativeRetained, nativeFreshReadRejected: !oldNativeReadable },
    proposedOrder: { webContextClosesBeforeFinalNativeLogin: true, finalNativeHandoffSharesLatestSession: true, finalNativeFreshReadAccepted: true },
    limits: ['This proves the installed authentication semantics and the harness ordering defect; it is not a new macOS lifecycle acceptance.', 'No credential, cookie, token, email or session identifier is included in this receipt.'],
  }
  const output = '/workspace/scratch/812e3b7d6d45/ops1512/evidence/desktop-multisession-order-proof.json'
  await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
} finally { globalThis.fetch = originalFetch }

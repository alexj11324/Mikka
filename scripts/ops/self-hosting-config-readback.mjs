// One-off, read-only evidence for #1560–#1563. No credential or provider body is
// printed. The workflow injects exactly the seven named Infisical secrets.
import { createSign } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const BOOLEAN_NAMES = ['MIKKA_BYOS_ENABLED', 'MIKKA_BYOS_CLAUDE_OAUTH', 'MIKKA_BYOS_CODEX_OAUTH', 'NEXT_PUBLIC_COMPUTER_ENABLED']
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const IDENT = /^[a-z][a-z0-9_]{0,80}$/

class ProbeFailure extends Error {
  constructor(code, cause) { super(code, cause === undefined ? undefined : { cause }); this.code = code }
}

/** The existing booleans use exactly '1'; other strings are not silently normalized. */
export function configurationReadback(env) {
  const classification = (name, yes, no) => env[`READ_${name}`] !== 'success' ? 'invalid'
    : env[name] === undefined ? 'unset' : env[name] === yes ? 'true' : env[name] === no ? 'false' : 'invalid'
  return {
    ...Object.fromEntries(BOOLEAN_NAMES.map(name => [name, classification(name, '1', '0')])),
    // For this enum, true means cloud and false means community. Never echo an arbitrary value.
    MIKKA_EDITION: classification('MIKKA_EDITION', 'cloud', 'community'),
  }
}

/** Select and validate only the public fields needed for the self-hosted manifest. */
export function publicAppConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SLUG.test(value.slug ?? '')
    || !value.permissions || typeof value.permissions !== 'object' || Array.isArray(value.permissions)
    || !Array.isArray(value.events) || value.events.length > 128) throw new ProbeFailure('invalid_app_response')
  const permissions = Object.entries(value.permissions)
  if (!permissions.length || permissions.length > 200 || permissions.some(([name, access]) => !IDENT.test(name) || !['read', 'write', 'admin'].includes(access))
    || value.events.some(event => typeof event !== 'string' || !IDENT.test(event))) throw new ProbeFailure('invalid_app_response')
  return { slug: value.slug, permissions: Object.fromEntries(permissions.sort(([a], [b]) => a.localeCompare(b))), events: [...new Set(value.events)].sort() }
}

export async function appReadback(env, fetcher = fetch, now = Date.now()) {
  if (env.READ_GITHUB_APP_ID !== 'success' || env.READ_GITHUB_APP_PRIVATE_KEY !== 'success'
    || !/^[1-9]\d*$/.test(env.GITHUB_APP_ID ?? '') || !env.GITHUB_APP_PRIVATE_KEY) throw new ProbeFailure('credentials_unavailable')
  let jwt
  try {
    const issuedAt = Math.floor(now / 1000) - 60
    const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url')
    const payload = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: env.GITHUB_APP_ID })}`
    const signature = createSign('RSA-SHA256').update(payload).sign(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n')).toString('base64url')
    jwt = `${payload}.${signature}`
  } catch (error) { throw new ProbeFailure('credentials_invalid', error) }
  let response
  try {
    response = await fetcher('https://api.github.com/app', {
      method: 'GET',
      headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'mikka-self-hosting-config-readback' },
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    })
  } catch (error) { throw new ProbeFailure('github_request_failed', error) }
  if (!response.ok) { await response.body?.cancel(); throw new ProbeFailure('github_request_refused') }
  try { return publicAppConfiguration(await response.json()) }
  catch (error) { throw new ProbeFailure('invalid_app_response', error) }
}

export async function runReadback({ env = process.env, fetcher = fetch, write = line => console.log(line) } = {}) {
  const configuration = configurationReadback(env)
  write(JSON.stringify({ configuration }))
  try {
    write(JSON.stringify({ githubApp: await appReadback(env, fetcher) }))
    return Object.values(configuration).includes('invalid') ? 1 : 0
  } catch (error) {
    write(JSON.stringify({ githubApp: { status: 'unavailable', reason: error instanceof ProbeFailure ? error.code : 'unexpected_failure' } }))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runReadback()

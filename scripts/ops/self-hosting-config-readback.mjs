// One-off, read-only evidence for #1560–#1563. No credential or provider body is
// printed. The workflow injects only named existing Infisical secrets. If four
// keys are absent there, the existing deployment identity reads those exact
// production entries from the fixed Vercel project, keeping values in memory.
import { createPrivateKey, createSign } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const BOOLEAN_NAMES = ['MIKKA_BYOS_ENABLED', 'MIKKA_BYOS_CLAUDE_OAUTH', 'MIKKA_BYOS_CODEX_OAUTH', 'NEXT_PUBLIC_COMPUTER_ENABLED']
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const IDENT = /^[a-z][a-z0-9_]{0,80}$/
const APP_ISSUER = /^(?:[1-9]\d{0,30}|Iv[A-Za-z0-9_.-]{8,126})$/
const VERCEL_PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
const VERCEL_TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const VERCEL_NAMES = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'NEXT_PUBLIC_COMPUTER_ENABLED', 'MIKKA_EDITION']

class ProbeFailure extends Error {
  constructor(code, cause) { super(code, cause === undefined ? undefined : { cause }); this.code = code }
}

export async function readVercelFallback(env, fetcher = fetch) {
  const resolved = { ...env }, evidence = {}
  if (env.READ_VERCEL_DEPLOY_TOKEN !== 'success' || !env.VERCEL_DEPLOY_TOKEN) throw new ProbeFailure('vercel_credentials_unavailable')
  const get = async path => {
    let response
    try {
      response = await fetcher(`https://api.vercel.com${path}`, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${env.VERCEL_DEPLOY_TOKEN}`, accept: 'application/json' } })
    } catch (error) { throw new ProbeFailure('vercel_request_failed', error) }
    if (!response.ok) { await response.body?.cancel(); throw new ProbeFailure('vercel_request_refused') }
    try { return await response.json() } catch (error) { throw new ProbeFailure('vercel_response_invalid', error) }
  }
  const inventory = await get(`/v10/projects/${VERCEL_PROJECT}/env?teamId=${VERCEL_TEAM}&decrypt=false`)
  if (!inventory || !Array.isArray(inventory.envs) || inventory.envs.length > 2_000 || inventory.pagination?.next) throw new ProbeFailure('vercel_response_invalid')
  for (const name of VERCEL_NAMES) {
    if (resolved[`READ_${name}`] === 'success') { evidence[name] = 'infisical'; continue }
    const rows = inventory.envs.filter(row => row?.key === name && Array.isArray(row.target) && row.target.includes('production') && !row.gitBranch)
    if (!rows.length) { delete resolved[name]; resolved[`READ_${name}`] = 'success'; evidence[name] = 'absent'; continue }
    if (rows.length !== 1 || typeof rows[0].id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(rows[0].id)) { evidence[name] = 'ambiguous'; continue }
    try {
      // Only a selected, validated provider ID reaches this fixed project path.
      const item = await get(`/v1/projects/${VERCEL_PROJECT}/env/${rows[0].id}?teamId=${VERCEL_TEAM}`)
      if (item?.key !== name || item.id !== rows[0].id || typeof item.value !== 'string'
        || !Array.isArray(item.target) || !item.target.includes('production') || item.gitBranch) throw new ProbeFailure('vercel_response_invalid')
      resolved[name] = item.value; resolved[`READ_${name}`] = 'success'; evidence[name] = 'found'
    } catch (error) { evidence[name] = error instanceof ProbeFailure ? error.code : 'unexpected_failure' }
  }
  return { env: resolved, evidence }
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

/** Diagnose representation without returning any input substring. */
export function valueShape(value, knownValues = []) {
  if (value === undefined) return { shape: 'unset', length: 0 }
  const length = value.length
  if (!length) return { shape: 'empty', length }
  const trimmed = value.trim()
  if (!trimmed) return { shape: 'whitespace', length }
  if (knownValues.includes(value)) return { shape: 'known_value', length }
  if (knownValues.includes(trimmed)) return { shape: 'trimmed_known_value', length }
  if (trimmed.length >= 2 && ['"', "'"].includes(trimmed[0]) && trimmed.at(-1) === trimmed[0]
    && knownValues.includes(trimmed.slice(1, -1))) return { shape: 'quoted_known_value', length }
  return { shape: 'other', length }
}

export function readbackDiagnostics(env) {
  const names = [...BOOLEAN_NAMES, 'MIKKA_EDITION']
  const values = Object.fromEntries(names.map(name => [name, {
    read: env[`READ_${name}`] === 'success' ? 'success' : 'unavailable',
    ...valueShape(env[name], name === 'MIKKA_EDITION' ? ['cloud', 'community'] : ['0', '1', 'true', 'false']),
  }]))
  const issuer = env.GITHUB_APP_ID
  const issuerShape = valueShape(issuer)
  if (issuer && APP_ISSUER.test(issuer)) issuerShape.shape = /^\d+$/.test(issuer) ? 'numeric_app_id' : 'app_client_id'
  else if (issuer && APP_ISSUER.test(issuer.trim())) issuerShape.shape = 'whitespace_issuer'
  const key = env.GITHUB_APP_PRIVATE_KEY
  const keyShape = valueShape(key)
  if (key?.trim()) {
    try { keyShape.shape = createPrivateKey(key.replace(/\\n/g, '\n')).asymmetricKeyType === 'rsa' ? 'rsa_private_key' : 'other_private_key' }
    catch { keyShape.shape = 'invalid_private_key' }
  }
  return { ...values, GITHUB_APP_ID: { read: env.READ_GITHUB_APP_ID === 'success' ? 'success' : 'unavailable', ...issuerShape },
    GITHUB_APP_PRIVATE_KEY: { read: env.READ_GITHUB_APP_PRIVATE_KEY === 'success' ? 'success' : 'unavailable', ...keyShape } }
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
    || !APP_ISSUER.test(env.GITHUB_APP_ID ?? '') || !env.GITHUB_APP_PRIVATE_KEY) throw new ProbeFailure('credentials_unavailable')
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
  if (env.READ_VERCEL_DEPLOY_TOKEN === 'success') {
    try { const result = await readVercelFallback(env, fetcher); env = result.env; write(JSON.stringify({ vercel: result.evidence })) }
    catch (error) { write(JSON.stringify({ vercel: { status: 'unavailable', reason: error instanceof ProbeFailure ? error.code : 'unexpected_failure' } })) }
  }
  const configuration = configurationReadback(env)
  write(JSON.stringify({ configuration }))
  write(JSON.stringify({ diagnostics: readbackDiagnostics(env) }))
  try {
    write(JSON.stringify({ githubApp: await appReadback(env, fetcher) }))
    return Object.values(configuration).includes('invalid') ? 1 : 0
  } catch (error) {
    write(JSON.stringify({ githubApp: { status: 'unavailable', reason: error instanceof ProbeFailure ? error.code : 'unexpected_failure' } }))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runReadback()

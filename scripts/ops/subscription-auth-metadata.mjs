import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const BRANCH = 'diagnostics/1217-subscription-auth-20261104'
const REPOSITORY = 'alexj11324/Mikka'
const OWNER_ID = '183887963', REPOSITORY_ID = '1427517699'
const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const IDENTITY = '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac'
const INFISICAL_PROJECT = '89850d6a-f020-4936-863e-df77380dfe40'
const INFISICAL = 'https://app.infisical.com'
const fail = code => { throw new Error(code) }
const relevantKey = key => typeof key === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(key)
  && (/^MIKKA_BYOS_|^INFISICAL_/.test(key) || ['BETTER_AUTH_OAUTH_PROXY_URL', 'BETTER_AUTH_OAUTH_PROXY_SECRET', 'BETTER_AUTH_URL'].includes(key))

export function assertWorkflow(env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_REPOSITORY_ID !== REPOSITORY_ID
    || env.GITHUB_REPOSITORY_OWNER_ID !== OWNER_ID || env.GITHUB_REF !== 'refs/heads/' + BRANCH
    || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_RUN_ATTEMPT !== '1'
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) fail('diagnostic_workflow_refused')
}

export function assertClaims(claims, env) {
  const ref = 'refs/heads/' + BRANCH
  const subject = `repo:alexj11324@${OWNER_ID}/Mikka@${REPOSITORY_ID}:ref:${ref}`
  if (claims.iss !== 'https://token.actions.githubusercontent.com' || claims.aud !== 'mikka-infisical'
    || claims.sub !== subject || claims.repository !== REPOSITORY || claims.repository_id !== REPOSITORY_ID
    || claims.repository_owner_id !== OWNER_ID || claims.ref !== ref || claims.sha !== env.GITHUB_SHA
    || claims.event_name !== 'push'
    || claims.workflow_ref !== `${REPOSITORY}/.github/workflows/subscription-auth-metadata.yml@${ref}`) fail('diagnostic_oidc_claims_refused')
}

/** Project values, ciphertext, comments and identities' credentials are deliberately discarded. */
export function metadataOnly(data) {
  if (!Array.isArray(data?.envs)) fail('diagnostic_env_shape')
  const rows = data.envs.filter(row => relevantKey(row.key)).map(row => {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(row.id ?? '') || !Array.isArray(row.target)
      || row.target.some(target => !['production', 'preview', 'development'].includes(target))) fail('diagnostic_env_metadata_invalid')
    return { key: row.key, id: row.id, target: [...row.target].sort() }
  })
  return rows.sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id))
}

async function json(fetchImpl, url, stage, options = {}) {
  let response
  try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) }) }
  catch { fail(stage + '_transport') }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); fail(stage + '_http_' + response.status) }
  try {
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > 2_000_000) fail(stage + '_oversized')
    return JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch { fail(stage + '_invalid_json') }
}

export async function diagnose({ env = process.env, fetchImpl = fetch } = {}) {
  assertWorkflow(env)
  const requestUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL)
  if (requestUrl.protocol !== 'https:' || !requestUrl.hostname.endsWith('.actions.githubusercontent.com')
    || requestUrl.username || requestUrl.password || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) fail('diagnostic_oidc_endpoint_refused')
  requestUrl.searchParams.set('audience', 'mikka-infisical')
  const oidc = await json(fetchImpl, requestUrl, 'github_oidc', { headers: { authorization: 'Bearer ' + env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } })
  if (typeof oidc.value !== 'string') fail('diagnostic_oidc_missing')
  let claims
  try { claims = JSON.parse(Buffer.from(oidc.value.split('.')[1], 'base64url').toString('utf8')) }
  catch { fail('diagnostic_oidc_invalid') }
  assertClaims(claims, env)
  // The existing identity verifies the signature and its configured trust. The local claims check cannot grant authority.
  const login = await json(fetchImpl, INFISICAL + '/api/v1/auth/oidc-auth/login', 'infisical_oidc', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityId: IDENTITY, jwt: oidc.value }),
  })
  if (typeof login.accessToken !== 'string' || !login.accessToken) fail('diagnostic_infisical_token_missing')
  const secretUrl = new URL('/api/v4/secrets/VERCEL_DEPLOY_TOKEN', INFISICAL)
  for (const [key, value] of Object.entries({ projectId: INFISICAL_PROJECT, environment: 'prod', secretPath: '/platform', type: 'shared', includeImports: 'false' })) secretUrl.searchParams.set(key, value)
  const secret = await json(fetchImpl, secretUrl, 'existing_vercel_token', { headers: { authorization: 'Bearer ' + login.accessToken } })
  const token = secret?.secret?.secretValue
  if (secret?.secret?.secretKey !== 'VERCEL_DEPLOY_TOKEN' || typeof token !== 'string' || !token) fail('diagnostic_vercel_token_missing')
  const vercel = async path => {
    const url = new URL(path, 'https://api.vercel.com'); url.searchParams.set('teamId', TEAM)
    return json(fetchImpl, url, path.includes('/env') ? 'vercel_env_metadata' : 'vercel_project_metadata', { headers: { authorization: 'Bearer ' + token } })
  }
  const project = await vercel('/v9/projects/' + PROJECT)
  if (project.id !== PROJECT || project.accountId !== TEAM || project.link?.type !== 'github'
    || String(project.link.repoId) !== REPOSITORY_ID) fail('diagnostic_project_mismatch')
  const data = await vercel('/v10/projects/' + PROJECT + '/env?decrypt=false')
  const entries = metadataOnly(data)
  return { schema: 1, status: 'read', source: env.GITHUB_SHA, branch: BRANCH, at: new Date().toISOString(),
    identity: IDENTITY, oidcClaimsVerified: true, project: PROJECT, team: TEAM,
    metadataOnly: true, decryptedValuesRequested: false, receivedEnvCount: data.envs.length, relevantEnvCount: entries.length, entries }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try { report = await diagnose() }
  catch (error) {
    const code = /^(diagnostic|github_oidc|infisical_oidc|existing_vercel_token|vercel_env_metadata|vercel_project_metadata)_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'diagnostic_failed'
    report = { schema: 1, status: 'blocked', code, at: new Date().toISOString() }; process.exitCode = 1
  }
  // Only this constructed allowlist report reaches disk or output. No raw responses or exception stacks.
  await writeFile('subscription-auth-metadata.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}

import { createSign } from 'node:crypto'

const repositories = new Map([
  ['alexj11324/mikka-cloud', 1448851980],
  ['alexj11324/mikka-web', 1429004608],
])
const credentials = [
  'PRIVATE_SOURCE_GITHUB_APP_ID',
  'PRIVATE_SOURCE_GITHUB_APP_PRIVATE_KEY',
  'PRIVATE_SOURCE_GITHUB_APP_INSTALLATION_ID',
  'MIKKA_CLOUD_READ_TOKEN',
  'MIKKA_MARKETING_READ_TOKEN',
]
const fail = code => { throw new Error(`PRIVATE_SOURCE_${code}`) }

export function privateSourceCompilerEnvironment(env) {
  const clean = { ...env }
  for (const name of credentials) delete clean[name]
  return clean
}

export async function privateSourceGitEnvironment({ env = process.env, repository, token, fetchImpl = fetch, now = Date.now } = {}) {
  const repositoryId = repositories.get(repository)
  if (!repositoryId) fail('REPOSITORY_INVALID')
  if (!token) {
    const appId = env.PRIVATE_SOURCE_GITHUB_APP_ID
    const installationId = env.PRIVATE_SOURCE_GITHUB_APP_INSTALLATION_ID
    const privateKey = env.PRIVATE_SOURCE_GITHUB_APP_PRIVATE_KEY
    if (!/^\d+$/.test(appId ?? '') || !/^\d+$/.test(installationId ?? '') || !privateKey) fail('APP_CREDENTIALS_REQUIRED')
    try {
      const issuedAt = Math.floor(now() / 1000) - 60
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
      const claims = Buffer.from(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId })).toString('base64url')
      const unsigned = `${header}.${claims}`
      const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey.replace(/\\n/g, '\n'), 'base64url')
      const response = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${unsigned}.${signature}`,
          'X-GitHub-Api-Version': '2026-03-10', 'Content-Type': 'application/json',
        },
        body: JSON.stringify({ repository_ids: [repositoryId], permissions: { contents: 'read' } }),
      })
      if (response.status !== 201) fail('APP_TOKEN_FAILED')
      const result = await response.json()
      if (typeof result.token !== 'string' || !result.token || /\s/.test(result.token) ||
          !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= now()) fail('APP_TOKEN_INVALID')
      token = result.token
    } catch {
      fail('APP_TOKEN_FAILED')
    }
  }
  if (typeof token !== 'string' || !token || /\s/.test(token)) fail('TOKEN_INVALID')
  return {
    ...privateSourceCompilerEnvironment(env),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

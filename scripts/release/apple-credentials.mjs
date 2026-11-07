// Existing Infisical names become the release tools' legacy input names only
// inside the trusted main runner. No credential is copied back to GitHub.
import { createPrivateKey } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function appleCredentialAliases(env, desktop = false) {
  if (!/^[A-Z0-9]{1,30}$/.test(env.ASC_API_KEY_ID ?? '') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(env.ASC_API_ISSUER_ID ?? '')) throw Error('RELEASE_APPLE_IDENTIFIERS_INVALID')
  let pem
  try {
    const source = env.ASC_API_KEY_P8 ?? ''
    const key = createPrivateKey(source.includes('-----BEGIN ') ? source : Buffer.from(source, 'base64'))
    if (key.asymmetricKeyType !== 'ec') throw Error('expected_ec_key')
    pem = key.export({ type: 'pkcs8', format: 'pem' })
  } catch (error) { throw Error('RELEASE_APPLE_KEY_INVALID', { cause: error }) }
  const result = { APPLE_API_KEY_P8_BASE64: Buffer.from(pem).toString('base64'), APPLE_API_KEY_ID: env.ASC_API_KEY_ID, APPLE_API_ISSUER: env.ASC_API_ISSUER_ID }
  if (desktop) {
    if (!env.APPLE_DEVELOPER_ID_P12_BASE64 || !env.APPLE_DEVELOPER_ID_P12_PASSWORD || !/^[A-Z0-9]{1,30}$/.test(env.APPLE_TEAM_ID ?? '')) throw Error('RELEASE_APPLE_CERTIFICATE_MISSING')
    Object.assign(result, { CSC_LINK: env.APPLE_DEVELOPER_ID_P12_BASE64, CSC_KEY_PASSWORD: env.APPLE_DEVELOPER_ID_P12_PASSWORD })
  }
  if (Object.values(result).some(value => typeof value !== 'string' || !value || /[\r\n]/.test(value))) throw Error('RELEASE_APPLE_ALIAS_INVALID')
  return result
}

export function prepareAppleCredentials(env = process.env, desktop = false) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || env.GITHUB_REPOSITORY_ID !== '1427517699' || env.GITHUB_REPOSITORY_OWNER_ID !== '183887963' || env.GITHUB_REF !== 'refs/heads/main' || !env.GITHUB_ENV) throw Error('RELEASE_APPLE_RUNNER_REQUIRED')
  const aliases = appleCredentialAliases(env, desktop)
  for (const value of Object.values(aliases)) console.log('::add-mask::' + value.replaceAll('%', '%25'))
  appendFileSync(env.GITHUB_ENV, Object.entries(aliases).map(([name, value]) => name + '=' + value + '\n').join(''))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { prepareAppleCredentials(process.env, process.argv[2] === '--desktop') }
  catch (error) { console.error(/^RELEASE_APPLE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'RELEASE_APPLE_CONFIGURATION_INVALID'); process.exitCode = 1 }
}

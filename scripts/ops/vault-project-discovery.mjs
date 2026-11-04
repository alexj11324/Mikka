import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const identityId = '2cf9fa19-b9db-4c08-8ca0-b31859f2cbac'
const targetName = 'Mikka Test Account Vault'
const report = { schemaVersion: 1, scope: 'existing-identity-authorized-project-metadata-only', identityId, targetName, startedAt: new Date().toISOString(), status: 'not_started', http: {}, targetProject: null, existingMikkaProjectVisible: null, secretValuesRead: false, credentialsExported: false, applicationCalls: 0, modelCalls: 0, identityOrPermissionChanges: 0, errors: [] }
let phase = 'environment'
const safeErrors = new Set(['environment','oidc_url','oidc_request','oidc_shape','identity_login','identity_shape','project_list','project_shape','target_ambiguous'])
async function jsonResponse(response, code) {
  report.http[code] = response.status
  if (!response.ok) { await response.body?.cancel(); throw new Error(code) }
  try { return await response.json() } catch { throw new Error(code) }
}
try {
  if (process.env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || process.env.GITHUB_REF !== 'refs/heads/acceptance/proactive-1157-1163' || process.env.GITHUB_EVENT_NAME !== 'push' || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('environment')
  phase = 'oidc_url'
  const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  if (oidcUrl.protocol !== 'https:' || !oidcUrl.hostname.endsWith('.actions.githubusercontent.com')) throw new Error('oidc_url')
  oidcUrl.searchParams.set('audience', 'mikka-infisical')
  phase = 'oidc_request'
  const oidc = await jsonResponse(await fetch(oidcUrl, { headers: { Authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(10000) }), 'oidc_request')
  if (typeof oidc.value !== 'string' || oidc.value.split('.').length !== 3) throw new Error('oidc_shape')
  phase = 'identity_login'
  const auth = await jsonResponse(await fetch('https://app.infisical.com/api/v1/auth/oidc-auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identityId, jwt: oidc.value }), redirect: 'error', signal: AbortSignal.timeout(10000) }), 'identity_login')
  if (typeof auth.accessToken !== 'string' || !auth.accessToken || auth.tokenType !== 'Bearer') throw new Error('identity_shape')
  phase = 'project_list'
  const data = await jsonResponse(await fetch('https://app.infisical.com/api/v1/projects', { headers: { Authorization: 'Bearer ' + auth.accessToken }, redirect: 'error', signal: AbortSignal.timeout(10000) }), 'project_list')
  if (!Array.isArray(data.projects) || data.projects.length > 1000) throw new Error('project_shape')
  const targets = data.projects.filter(p => p && p.name === targetName)
  if (targets.length > 1) throw new Error('target_ambiguous')
  report.existingMikkaProjectVisible = data.projects.some(p => p && p.id === '89850d6a-f020-4936-863e-df77380dfe40' && p.name === 'Mikka')
  if (targets.length) {
    const target = targets[0]
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(target.id ?? '')) throw new Error('project_shape')
    report.targetProject = { id: target.id, name: targetName, devEnvironmentVisible: Array.isArray(target.environments) && target.environments.some(e => e?.slug === 'dev') }
  }
  report.status = targets.length === 1 ? 'target_visible' : 'target_not_visible_to_existing_identity'
} catch (error) {
  report.status = 'metadata_check_unavailable'
  report.errors.push(safeErrors.has(error?.message) ? error.message : safeErrors.has(phase) ? phase : 'environment')
} finally {
  report.finishedAt = new Date().toISOString()
  const dir = path.join(process.env.GITHUB_WORKSPACE ?? process.cwd(), 'vault-project-metadata')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (report.status === 'metadata_check_unavailable') process.exitCode = 1
}

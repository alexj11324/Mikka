import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export const plan = Object.freeze({ branch: 'ops/self-hosted-push-audit-20261108', source: '9e18c6b8122781fe89b1b3a9448bb9b1cec6d15a',
  privateSource: '06127b7df6dd9704450b11a07eed28a0b999db01', appId: '902ffab1-ed16-482e-8b83-2b7535079810',
  publicProject: 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', privateProject: 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc',
  team: 'team_C7lwxVVvnUicFli6112mvxpv', origin: 'https://app.aspectlylabs.com' })
const check = (value, code) => { if (!value) throw new Error(code) }
export function senderDeploymentGate({ variables, deployment, source }) {
  const found = variables.filter(v => v.key === 'EXPO_ACCESS_TOKEN' && v.target?.includes('production'))
  check(found.length === 1 && ['sensitive','encrypted'].includes(found[0].type), 'SENDER_CONFIGURATION')
  const floor = Math.max(Number(found[0].createdAt), Number(found[0].updatedAt ?? found[0].createdAt))
  check(Number.isSafeInteger(floor) && floor > 0, 'SENDER_TIME_UNKNOWN')
  check(deployment.readyState === 'READY' && deployment.target === 'production'
    && deployment.meta?.githubCommitSha === source, 'DEPLOYMENT_SOURCE')
  check(Number.isSafeInteger(deployment.createdAt) && deployment.createdAt >= floor, 'SENDER_NOT_YET_DEPLOYED')
  return { source, deploymentId: deployment.id, deploymentCreatedAt: deployment.createdAt,
    senderConfigurationUpdatedAt: floor, sensitiveSender: true }
}

async function run(env, apply) {
  assert.equal(env.GITHUB_REPOSITORY, 'alexj11324/Mikka'); assert.equal(env.GITHUB_REF, 'refs/heads/' + plan.branch)
  assert.equal(env.GITHUB_ACTOR, 'alexj11324'); assert.equal(env.GITHUB_EVENT_NAME, 'push')
  assert.ok(env.VERCEL_TEAM_TOKEN && env.EXPO_TOKEN && env.EXPO_ACCESS_TOKEN)
  const report = { scope: 'exact-project-push-security', apply, pushes: 0, mutations: 0, gates: {} }
  const json = async (url, options = {}) => {
    const r = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000), redirect: 'error' })
    check(r.ok, `PROVIDER_HTTP_${r.status}`); return r.json()
  }
  const vercel = path => json('https://api.vercel.com' + path + (path.includes('?') ? '&' : '?') + 'teamId=' + plan.team,
    { headers: { authorization: `Bearer ${env.VERCEL_TEAM_TOKEN}` } })
  const gql = async (query, token = env.EXPO_TOKEN) => {
    const result = await json('https://api.expo.dev/graphql', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
    check(!result.errors, 'EXPO_OPERATION_REFUSED'); return result.data
  }
  const readApp = async token => (await gql(`query {app {byId(appId:"${plan.appId}") {id slug pushSecurityEnabled ownerAccount {id pushSecurityEnabled}}}}`, token)).app.byId
  try {
    const main = await json('https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main')
    check(main.object?.sha === plan.source, 'MAIN_SOURCE_DRIFT')
    check((await json(plan.origin + '/mikka/api/version')).build === plan.source, 'PUBLIC_SOURCE_DRIFT')
    for (const [name, id, source] of [['public', plan.publicProject, plan.source], ['private', plan.privateProject, plan.privateSource]]) {
      const variables = await vercel(`/v10/projects/${id}/env?decrypt=false&target=production`)
      const project = await vercel(`/v9/projects/${id}`)
      check(typeof project.targets?.production?.id === 'string', 'PRODUCTION_TARGET')
      const deployment = await vercel(`/v13/deployments/${project.targets.production.id}`)
      report.gates[name] = senderDeploymentGate({ variables: variables.envs, deployment, source })
    }
    const app = await readApp(env.EXPO_TOKEN), sender = await readApp(env.EXPO_ACCESS_TOKEN)
    check(app.id === plan.appId && app.slug === 'mikka' && sender.id === app.id
      && sender.ownerAccount.id === app.ownerAccount.id, 'EXACT_PROJECT_ACCESS')
    report.before = { projectSecurity: app.pushSecurityEnabled, accountSecurity: app.ownerAccount.pushSecurityEnabled }
    if (apply && !app.pushSecurityEnabled) {
      const schema = await gql('query {__schema {mutationType {fields {name type {name ofType {name}}}}}}')
      check(schema.__schema.mutationType.fields.some(f => f.name === 'app' && (f.type.name ?? f.type.ofType?.name) === 'AppMutation'), 'EXPO_MUTATION_SCHEMA')
      const result = await gql(`mutation {app {setPushSecurityEnabled(appId:"${plan.appId}",pushSecurityEnabled:true) {id pushSecurityEnabled}}}`)
      check(result.app?.setPushSecurityEnabled?.id === plan.appId && result.app.setPushSecurityEnabled.pushSecurityEnabled === true, 'EXPO_MUTATION_UNCONFIRMED')
      report.mutations = 1
    }
    const after = await readApp(env.EXPO_ACCESS_TOKEN)
    check(after.ownerAccount.pushSecurityEnabled === report.before.accountSecurity, 'ACCOUNT_SETTING_CHANGED')
    if (apply) check(after.pushSecurityEnabled === true, 'EXPO_SETTING_UNCONFIRMED')
    report.after = { projectSecurity: after.pushSecurityEnabled, accountSecurity: after.ownerAccount.pushSecurityEnabled }
    report.status = apply ? 'enabled' : 'ready'
  } catch (error) {
    report.status = 'waiting'; report.code = /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message ?? '') ? error.message : 'PUSH_SECURITY_GATE'
    if (apply) process.exitCode = 1
  }
  console.log(JSON.stringify(report))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run(process.env, process.argv.includes('--apply'))

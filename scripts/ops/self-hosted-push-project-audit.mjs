import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
assert.equal(process.env.GITHUB_REPOSITORY, 'alexj11324/Mikka')
assert.equal(process.env.GITHUB_REF, 'refs/heads/ops/self-hosted-push-audit-20261108')
assert.equal(process.env.GITHUB_ACTOR, 'alexj11324')
assert.equal(process.env.GITHUB_EVENT_NAME, 'push')
assert.ok(process.env.EXPO_TOKEN && process.env.EXPO_ACCESS_TOKEN)
const appId = '902ffab1-ed16-482e-8b83-2b7535079810'
const query = `query { app { byId(appId:"${appId}") {id slug pushSecurityEnabled ownerAccount {id pushSecurityEnabled}} } mutationType: __type(name:"AppMutation") {fields {name type {kind name ofType {kind name}}}} }`
const report = { scope: 'exact-project-read-only', pushes: 0, mutations: 0, checks: {} }
for (const [name, token] of [['operator', process.env.EXPO_TOKEN], ['sender', process.env.EXPO_ACCESS_TOKEN]]) {
  const r = await fetch('https://api.expo.dev/graphql', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }) })
  const body = r.ok ? await r.json() : null
  const app = body?.data?.app?.byId
  report.checks[name] = { status: r.status, appMatches: app?.id === appId, slugMatches: app?.slug === 'mikka',
    appSecurity: typeof app?.pushSecurityEnabled === 'boolean' ? app.pushSecurityEnabled : null,
    accountSecurity: typeof app?.ownerAccount?.pushSecurityEnabled === 'boolean' ? app.ownerAccount.pushSecurityEnabled : null,
    accountHash: app?.ownerAccount?.id ? createHash('sha256').update(app.ownerAccount.id).digest('hex').slice(0, 16) : null,
    errors: body?.errors?.map(e => /^[A-Z_]{1,80}$/.test(e.extensions?.code ?? '') ? e.extensions.code : 'unknown') ?? [] }
  report.mutationReturnType = body?.data?.mutationType?.fields?.find(f => f.name === 'setPushSecurityEnabled')?.type ?? null
}
console.log(JSON.stringify(report))

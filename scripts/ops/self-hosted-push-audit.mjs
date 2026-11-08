import assert from 'node:assert/strict'
assert.equal(process.env.GITHUB_REPOSITORY, 'alexj11324/Mikka')
assert.equal(process.env.GITHUB_REF, 'refs/heads/ops/self-hosted-push-audit-20261108')
assert.equal(process.env.GITHUB_ACTOR, 'alexj11324')
assert.equal(process.env.GITHUB_EVENT_NAME, 'push')
assert.ok(process.env.VERCEL_TEAM_TOKEN && process.env.EXPO_TOKEN)
const report = { scope: 'provider-configuration-read-only', started: new Date().toISOString(), pushes: 0, mutations: 0, env: {}, schema: {} }
const get = async (url, init) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'error' })
  if (!r.ok) { await r.body?.cancel(); return { status: r.status } }
  return { status: r.status, data: await r.json() }
}
for (const [name, id] of [['public', 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'], ['private', 'prj_vhbbfNIkhDO6grmZ3f6zMUH6k7rc']]) {
  const r = await get(`https://api.vercel.com/v10/projects/${id}/env?decrypt=false&target=production&teamId=team_C7lwxVVvnUicFli6112mvxpv`, { headers: { authorization: `Bearer ${process.env.VERCEL_TEAM_TOKEN}` } })
  const variables = r.data?.envs?.filter(v => v.key === 'EXPO_ACCESS_TOKEN' && v.target?.includes('production'))
  report.env[name] = { status: r.status, matching: variables?.length ?? null,
    types: variables?.map(v => ['sensitive','encrypted','plain','system'].includes(v.type) ? v.type : 'unknown') ?? [] }
}
const query = `query { account: __type(name:"Account") { fields { name } } app: __type(name:"App") { fields {name} } accountMutation: __type(name:"AccountMutation") {fields {name args {name type {kind name ofType {kind name}}}}} appMutation: __type(name:"AppMutation") {fields {name args {name type {kind name ofType {kind name}}}}} accountInput: __type(name:"AccountUpdateInput") {inputFields {name type {kind name ofType {kind name}}}} }`
const result = await get('https://api.expo.dev/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.EXPO_TOKEN}` }, body: JSON.stringify({ query }) })
report.expoStatus = result.status
if (result.data?.errors) report.expoErrorCodes = result.data.errors.map(e => /^[A-Z_]{1,80}$/.test(e.extensions?.code ?? '') ? e.extensions.code : 'unknown')
for (const [name, type] of Object.entries(result.data?.data ?? {})) {
  report.schema[name] = (type?.fields ?? type?.inputFields ?? []).filter(f => /push|secur/i.test(f.name))
}
report.finished = new Date().toISOString()
console.log(JSON.stringify(report))

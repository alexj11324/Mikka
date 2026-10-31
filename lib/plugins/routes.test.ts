import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'

const calls: unknown[][] = []
let owner: string | null = 'owner'
const stub = (path: string, namedExports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports })
stub('../api-auth.ts', { auth: { api: { getSession: async () => owner ? { user: { id: owner } } : null } } })
stub('../request-log.ts', { noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler })
stub('./runtime.ts', { personalPlugins: {
  listMcp: async (userId: string) => { calls.push(['listMcp', userId]); return [] },
  createMcp: async (...args: unknown[]) => { calls.push(['createMcp', ...args]); return { id: randomUUID(), authKind: 'header' } },
  updateMcp: async (...args: unknown[]) => { calls.push(['updateMcp', ...args]); return {} },
  deleteMcp: async (...args: unknown[]) => { calls.push(['deleteMcp', ...args]) },
  listSkills: async (userId: string) => { calls.push(['listSkills', userId]); return [] },
  installSkill: async (...args: unknown[]) => { calls.push(['installSkill', ...args]); return {} },
  updateSkill: async (...args: unknown[]) => { calls.push(['updateSkill', ...args]); return {} },
  deleteSkill: async (...args: unknown[]) => { calls.push(['deleteSkill', ...args]) },
} })
stub('./skill-source.ts', { fetchSkillSource: async (input: unknown) => ({ ...input as object, body: '# Fixture' }) })
stub('../composio.ts', { getComposio: () => ({}) })
stub('./catalog.ts', { listAppCatalog: async () => [{ id: 'googledrive' }] })
let mcp: typeof import('../../app/api/integrations/mcp/route'), skills: typeof import('../../app/api/skills/route'), catalog: typeof import('../../app/api/integrations/composio/catalog/route')
before(async () => { mcp = await import('../../app/api/integrations/mcp/route'); skills = await import('../../app/api/skills/route'); catalog = await import('../../app/api/integrations/composio/catalog/route') })
function request(path: string, method = 'GET', data?: unknown, origin = 'https://mikka.acme.dev') {
  return new Request(`https://mikka.acme.dev${path}`, { method, headers: { origin, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
}
test('actual routes require authentication and same-origin mutations before storage/source access', async () => {
  owner = null; calls.length = 0
  for (const handler of [mcp.GET, skills.GET, catalog.GET]) assert.equal((await handler(request('/api/skills'))).status, 401)
  owner = 'owner'
  for (const handler of [mcp.POST, mcp.PATCH, mcp.DELETE, skills.POST, skills.PATCH, skills.DELETE]) assert.equal((await handler(request('/api/skills', 'POST', {}, 'https://evil.acme.dev'))).status, 403)
  assert.deepEqual(calls, [])
})
test('actual routes use the authenticated owner, reject injected owners and expose counts without credentials', async () => {
  owner = 'owner'; calls.length = 0
  assert.deepEqual(await (await mcp.GET(request('/api/integrations/mcp'))).json(), { servers: [], count: 0 })
  assert.deepEqual(await (await skills.GET(request('/api/skills'))).json(), { skills: [], count: 0, scope: 'personal' })
  const input = { name: 'MCP', url: 'https://mcp.acme.dev', auth: { name: 'Authorization', value: 'synthetic-secret' } }
  assert.equal((await mcp.POST(request('/api/integrations/mcp', 'POST', { ...input, userId: 'peer' }))).status, 400)
  const response = await mcp.POST(request('/api/integrations/mcp', 'POST', input))
  assert.equal(response.status, 201); assert.ok(!(await response.text()).includes(input.auth.value))
  assert.equal(calls.at(-1)?.[1], 'owner')
  assert.equal((await skills.POST(request('/api/skills', 'POST', { source: 'owner/repo', slug: 'example' }))).status, 201)
  assert.equal(calls.at(-1)?.[1], 'owner')
  assert.equal((await catalog.GET(request('/api/integrations/composio/catalog'))).status, 200)
  const oversized = request('/api/skills', 'POST', { source: 'x'.repeat(17_000), slug: 'x' })
  assert.equal((await skills.POST(oversized)).status, 413)
})

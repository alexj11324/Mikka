import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fetchWorkspaceIssues, fetchWorkspaceProjects } from '../lib/workspace-lists.ts'

const source = path => readFile(new URL(path, import.meta.url), 'utf8')

test('项目与任务读取并行 GET，不经过串行 Server Action 队列，日期类型保留', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  const pending = []
  globalThis.fetch = (url, options) => new Promise(resolve => {
    requests.push({ url, options })
    pending.push(() => resolve(Response.json([{ id: url, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T01:00:00Z' }])))
  })
  try {
    const both = Promise.all([fetchWorkspaceIssues(), fetchWorkspaceProjects()])
    assert.equal(requests.length, 2)
    assert.match(requests[0].url, /\/api\/workspace\/lists\?kind=issues$/)
    assert.match(requests[1].url, /\/api\/workspace\/lists\?kind=projects$/)
    for (const { options } of requests) {
      assert.equal(options.cache, 'no-store')
      assert.equal(options.credentials, 'same-origin')
      assert.ok(!options.method || options.method === 'GET')
    }
    pending.forEach(resolve => resolve())
    for (const [row] of await both) {
      assert.ok(row.createdAt instanceof Date)
      assert.ok(row.updatedAt instanceof Date)
    }
  } finally { globalThis.fetch = originalFetch }
})

test('列表加载失败不能被当成空列表', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 401 })
  try { await assert.rejects(fetchWorkspaceIssues(), /workspaceListReadFailed/) }
  finally { globalThis.fetch = originalFetch }
})

test('首屏不静态引入设置、插件、搜索及拖拽看板，也不读取 Agent 历史', async () => {
  const workspace = await source('../components/workspace/issue-workspace.tsx')
  for (const name of ['SettingsView', 'PluginsSkillsView', 'IssueSearch', 'IssueBoard']) {
    assert.doesNotMatch(workspace, new RegExp(`import \\{ ${name} \\} from`))
    assert.match(workspace, new RegExp(`const ${name} = dynamic\\(`))
  }
  assert.doesNotMatch(workspace, /useAgentHistory/)
  assert.match(workspace, /\['my-issues', 'team-issues', 'all-issues'\].includes\(next\)\) void import\('\.\/issue-board'\)/)
  assert.match(workspace, /\['issues', user.id\], fetchWorkspaceIssues/)
  assert.match(workspace, /\['projects', user.id\], fetchWorkspaceProjects/)
})

test('GET 列表复用现有用户权限检查，禁止公共缓存', async () => {
  const route = await source('../app/api/workspace/lists/route.ts')
  assert.match(route, /await listIssues\(\) : await listProjects\(\)/)
  assert.match(route, /private, no-store/)
  assert.match(route, /status: 401/)
  assert.match(route, /status: 400/)
})

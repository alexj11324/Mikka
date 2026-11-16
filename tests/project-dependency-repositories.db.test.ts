import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { GitHubAccessError } from '../lib/github/user-access-error'
import { dbUrl, seedProject, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

const directory = new Map<string, { id: string; fullName: string }[]>()
const requests: string[] = []
mock.module(new URL('../lib/github/user-access.ts', import.meta.url).href, { namedExports: {
  GitHubAccessError,
  recentRepositoryPullAuthors: async (actor: string, key: string, term: string) => {
    requests.push(actor + '/' + key + '/' + term)
    return ['Ada']
  },
  listRepositoriesForUser: async (userId: string) => {
    requests.push(userId)
    const repositories = directory.get(userId)
    if (!repositories) throw new GitHubAccessError('githubUnavailable', 502)
    return { repositories }
  },
} })

test('dependency references use stable GitHub ids, retain hidden selections and never grant execution repository access', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl })
  const { listDependencyRepositories: list, replaceDependencyRepositories: replace } = await import('../lib/project-resources/dependency-repositories')
  const { projectPullAuthors } = await import('../lib/project-resources/pull-authors')
  const { pool: app } = await import('../lib/db'), { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), app.end(), workspacePool.end()]) })
  const admin = await seedUser(pool, 'dependency-admin'), member = await seedUser(pool, 'dependency-reader')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const team = await seedTeam(pool, ws.id, admin), projectId = await seedProject(pool, admin, [{ teamId: team.id, workspaceId: ws.id }])
  const scope = { workspaceId: ws.id, projectId }, a = { id: '11', fullName: 'fixture/first' }, b = { id: '12', fullName: 'fixture/second' }
  directory.set(admin, [a,b]); directory.set(member, [a, { id: '17', fullName: 'fixture/unselected' }])
  const before = await list(admin, scope)
  assert.deepEqual(before.selected, [])
  assert.equal(before.canReplace, true)
  const result = await replace(admin, { ...scope, revision: 1, repos: [b.id,a.id] })
  assert.equal(result.revision, 2); assert.deepEqual(result.selected, [a.id,b.id])
  const same = await replace(admin, { ...scope, revision: 2, repos: [a.id,b.id] })
  assert.equal(same.revision, 2)
  await assert.rejects(replace(admin, { ...scope, revision: 1, repos: [] }), { code: 'projectResourceConflict' })
  const read = await list(member, scope)
  assert.deepEqual(read.selected, [a.id]); assert.deepEqual(read.repositories, [{ id: a.id, name: a.fullName }]); assert.equal(read.canReplace, false)
  await assert.rejects(replace(member, { ...scope, revision: 2, repos: [] }))
  directory.set(admin, [a])
  await assert.rejects(replace(admin, { ...scope, revision: 2, repos: [] }), { code: 'projectRepositoryDenied' })
  assert.equal((await list(admin, scope)).canReplace, false)
  directory.set(admin, [a, { ...b, fullName: 'fixture/renamed' }])
  const renamed = await list(admin, scope)
  assert.deepEqual(renamed.selected, [a.id,b.id]); assert.ok(renamed.repositories.some(repo => repo.name === 'fixture/renamed'))
  await pool.query('insert into workspace_repository_policies ("workspaceId",mode,"repositoryKeys","updatedBy") values ($1,\'restricted\',$2,$3)', [ws.id, JSON.stringify(['v2/github.com/fixture/first']),admin])
  await assert.rejects(replace(admin,{...scope,revision:2,repos:[b.id]}),{code:'projectRepositoryDenied'})
  assert.equal((await list(admin,scope)).selected.includes(b.id), false)
  await pool.query('delete from workspace_repository_policies where "workspaceId"=$1',[ws.id])
  assert.equal((await replace(admin, { ...scope, revision: 2, repos: [] })).revision, 3)
  const sql = await pool.query('select (select count(*)::int from workspace_project_repositories where "projectId"=$1) as checkout, (select count(*)::int from workspace_resource_events where "resourceId"=$1 and kind=\'project_dependencies.changed\') as events', [projectId])
  assert.deepEqual(sql.rows[0], { checkout: 0, events: 2 })
  const key = 'v2/github.com/fixture/first'
  const search = () => projectPullAuthors({ id: member }, { ...scope, readerId: member, repository: key, query: 'ad' })
  const countBeforeSearch = requests.length
  assert.deepEqual(await search(), [])
  assert.equal(requests.length, countBeforeSearch)
  await pool.query('insert into workspace_project_repositories ("projectId","workspaceId","repositoryKey") values ($1,$2,$3)', [projectId, ws.id, key])
  assert.deepEqual(await search(), ['Ada'])
  assert.equal(requests.at(-1), member + '/' + key + '/ad')
  await pool.query(`insert into workspace_repository_policies ("workspaceId",mode,"repositoryKeys","updatedBy") values ($1,'restricted','[]',$2)`, [ws.id, admin])
  assert.deepEqual(await search(), [])
  assert.equal(requests.length, countBeforeSearch + 1)
  directory.delete(admin)
  await assert.rejects(list(admin,scope), {code:'projectDependencyReaderUnavailable'})
  await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2',[ws.id,member]);const count=requests.length
  await assert.rejects(list(member,scope));assert.equal(requests.length,count)
})

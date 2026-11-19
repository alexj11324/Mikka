import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { ApiSession } from '../lib/api-auth'
import { dbUrl, seedProject, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('private device checkout bookmarks use current Project and device ownership', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl })
  const { listDeviceCheckouts, writeDeviceCheckout, setCheckoutBody } = await import('../lib/project-resources/device-checkouts')
  const { removeOwnedDevice } = await import('../lib/device-removal')
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([database.end(), pool.end(), workspacePool.end()]) })
  const account = async (name: string): Promise<ApiSession> => {
    const id = await seedUser(database, name)
    return { user: { id, name, email: id + '@example.invalid', image: null }, session: { id: randomUUID() } }
  }
  const admin = await account('checkout-admin'), member = await account('checkout-member')
  const { id: workspaceId } = await seedWorkspace(database, admin.user.id, [
    { userId: admin.user.id, role: 'admin' }, { userId: member.user.id, role: 'member' },
  ])
  const team = await seedTeam(database, workspaceId, admin.user.id)
  const projectId = await seedProject(database, admin.user.id, [{ teamId: team.id, workspaceId }])
  const ref = { workspaceId, projectId }
  const newDevice = async (owner: ApiSession, kind = 'local') => {
    const id = randomUUID()
    await database.query('insert into devices(id,"ownerId",name,kind) values($1,$2,$3,$4)', [id, owner.user.id, 'Fixture device', kind])
    return id
  }
  const deviceId = await newDevice(member), second = await newDevice(member), admins = await newDevice(admin)
  const set = (id: string, root: string | null, who = member) => writeDeviceCheckout(who, { ...ref, deviceId: id }, root)
  const list = (who = member) => listDeviceCheckouts(who, ref)
  await t.test('set, replace, list and clear once per device and Project across retries', async () => {
    const result = await set(deviceId, '/example/one')
    assert.deepEqual(Object.keys(result!).sort(), ['deviceId', 'projectId', 'root', 'updatedAt'])
    assert.deepEqual(await set(deviceId, '/example/one'), result)
    await Promise.all([set(second, '/example/two'), set(deviceId, '/example/replaced')])
    assert.deepEqual((await list()).map(item => item.root).sort(), ['/example/replaced', '/example/two'])
    assert.deepEqual((await list()).map(item => item.deviceId).sort(), [deviceId, second].sort())
    await set(second, null); await set(second, null)
    assert.deepEqual((await list()).map(item => item.root), ['/example/replaced'])
  })
  await t.test('independent Workspace administrator and personal access token cannot read or replace member folders', async () => {
    assert.deepEqual(await list(admin), [])
    await assert.rejects(set(deviceId, '/example/forbidden', admin), { detail: 'not_found' })
    await assert.rejects(set(deviceId, null, admin), { detail: 'not_found' })
    await set(admins, 'C:\\example\\own', admin)
    assert.deepEqual((await list()).map(row => row.root), ['/example/replaced'])
    await assert.rejects(list({ ...member, tokenId: 'fixture' }), { detail: 'access_denied' })
    await assert.rejects(set(deviceId, null, { ...member, tokenId: 'fixture' }), { detail: 'access_denied' })
  })
  await t.test('active Project, ACL and tenant are independently required for read and write', async () => {
    const { id: other } = await seedWorkspace(database, member.user.id, [{ userId: member.user.id, role: 'admin' }])
    await assert.rejects(listDeviceCheckouts(member, { workspaceId: other, projectId }), { detail: 'not_found' })
    await database.query("update resource_access_policies set visibility='private' where kind='project' and id=$1", [projectId])
    await assert.rejects(list(), { detail: 'not_found' })
    await assert.rejects(set(deviceId, '/example/private'), { detail: 'not_found' })
    await database.query("update resource_access_policies set visibility='shared' where kind='project' and id=$1", [projectId])
    assert.deepEqual((await list()).map(row => row.root), ['/example/replaced'])
    await database.query("update mikka_workspace_members set status='suspended' where \"workspaceId\"=$1 and \"userId\"=$2", [workspaceId, member.user.id])
    await assert.rejects(list())
    await assert.rejects(set(deviceId, '/example/suspended'))
    await database.query("update mikka_workspace_members set status='active' where \"workspaceId\"=$1 and \"userId\"=$2", [workspaceId, member.user.id])
    assert.deepEqual((await list()).map(row => row.root), ['/example/replaced'])
    await database.query('update workspace_projects set "archivedAt"=now() where id=$1', [projectId])
    await assert.rejects(list(), { detail: 'not_found' })
    await assert.rejects(set(deviceId, null), { detail: 'not_found' })
    await database.query('update workspace_projects set "archivedAt"=null where id=$1', [projectId])
  })
  await t.test('native paths are inert metadata and removal purges private pointers without creating scheduler objects', async () => {
    assert.equal(setCheckoutBody.safeParse({ projectId, root: '../relative' }).success, false)
    assert.equal(setCheckoutBody.safeParse({ projectId, root: '/bad\u0000path' }).success, false)
    const cloud = await newDevice(member, 'cloud')
    await assert.rejects(set(cloud, '/example/cloud'), { detail: 'not_found' })
    await removeOwnedDevice(member.user.id, deviceId)
    await assert.rejects(set(deviceId, '/example/tombstone'), { detail: 'not_found' })
    assert.deepEqual(await list(), [])
    assert.equal((await database.query('select 1 from device_project_checkouts where "deviceId"=$1', [deviceId])).rowCount, 0)
    assert.equal((await database.query('select 1 from device_repos where "deviceId"=$1', [deviceId])).rowCount, 0)
    await database.query("delete from resource_access_policies where kind='project' and id=$1", [projectId])
    assert.equal((await database.query('select 1 from device_project_checkouts where "projectId"=$1', [projectId])).rowCount, 0)
  })
})

const {test} = require('node:test')
const assert = require('node:assert/strict')
const {randomUUID} = require('node:crypto')
const {createRequire} = require('node:module')
const app = createRequire(process.cwd() + '/package.json')
const {assertE2eTarget} = app('./tests/helpers/e2e-target.mjs')
assertE2eTarget(process.env.E2E_DATABASE_URL)
assert.equal(process.env.E2E_DATABASE_URL,process.env.DATABASE_URL)
assert.equal(process.env.E2E_DATABASE_URL,process.env.MIKKA_DATABASE_URL)
test('archived organization lookup rechecks active ownership after demotion, suspension and removal on the next read', async t => {
  const {createOrganization,addOrganizationMember,archiveOrganization,listArchivedOrganizations} = app('./lib/governance/organizations.ts')
  const {pool} = app('./lib/db'); const {workspacePool} = app('./lib/workspace-db')
  t.after(async()=>{await Promise.all([pool.end(),workspacePool.end()])})
  const actors = ['retained','departing','second'].map(name=>({id:randomUUID(),name,email:randomUUID()+'@access.example.invalid'}))
  for(const a of actors) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$2,$3,true,now(),now())',[a.id,a.name,a.email])
  const [retained,departing,second] = actors
  const a = await createOrganization(retained,{name:'First retained test organization'})
  const b = await createOrganization(second,{name:'Separate retained test organization'})
  await addOrganizationMember(a.id,retained.id,{userId:departing.id,role:'owner'})
  await archiveOrganization(a.id,retained.id); await archiveOrganization(b.id,second.id)
  const lookup = user => listArchivedOrganizations(user.id)
  await t.test('active owners read their own retained names across two independent organizations',async()=>{
    assert.deepEqual(await lookup(retained),[{id:a.id,name:a.name}])
    assert.deepEqual(await lookup(departing),[{id:a.id,name:a.name}])
    assert.deepEqual(await lookup(second),[{id:b.id,name:b.name}])
  })
  // The archive is already closed for edits. Change only the isolated fixture membership
  // to exercise the reader against persisted post-archive database states.
  const reset = async (role,status) => {
    const write = await workspacePool.query('update mikka_organization_members set role=$3,status=$4 where "organizationId"=$1 and "userId"=$2',[a.id,departing.id,role,status])
    assert.equal(write.rowCount,1)
  }
  await t.test('demoted former owner immediately loses the retained name',async()=>{
    await reset('admin','active'); assert.deepEqual(await lookup(departing),[])
  })
  await t.test('suspended owner cannot read another owner’s archived organization',async()=>{
    await reset('owner','suspended'); assert.deepEqual(await lookup(departing),[])
    assert.deepEqual(await lookup(retained),[{id:a.id,name:a.name}])
  })
  await t.test('removed membership grants no archived listing and does not alter the other tenant',async()=>{
    const removed=await workspacePool.query('delete from mikka_organization_members where "organizationId"=$1 and "userId"=$2',[a.id,departing.id])
    assert.equal(removed.rowCount,1); assert.deepEqual(await lookup(departing),[])
    assert.deepEqual(await lookup(second),[{id:b.id,name:b.name}])
  })
})

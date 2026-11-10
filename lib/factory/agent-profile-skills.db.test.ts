import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { WorkspaceSkillStore } from '@/lib/plugins/workspace-skill'
import { AgentProfileStore } from './agent-profile-store'
import { agentProfileDigest, AgentProfileError, parseAgentProfile } from './agent-profile-definition'
import { agentProfileSkillAvailability, agentProfileSkillCatalog, resolveAgentProfileSkillsFor } from './agent-profile-skills'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

test('Profile Skills: personal and workspace sources stay owner/workspace scoped and profiles pin the saved body', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('@/lib/db'), import('@/lib/workspace-db')])
  const migrations = ['20261104231000_agent_profiles.sql', '20261031040000_personal_plugins.sql', '20261110200000_agent_profile_skill_shares.sql']
  for (const migration of migrations) await pool.query(await readFile(new URL(`../../drizzle/${migration}`, import.meta.url), 'utf8'))
  const owners: string[] = [], workspaces: string[] = []
  t.after(async () => {
    await pool.query('DELETE FROM factory_agent_profiles WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM personal_skill_workspace_shares WHERE workspace_id=ANY($1::uuid[])', [workspaces])
    await pool.query('DELETE FROM personal_skills WHERE user_id=ANY($1)', [owners])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaces])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [owners])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const owner = await seedUser(pool, 'profile-skills-owner'), member = await seedUser(pool, 'profile-skills-member'), outsider = await seedUser(pool, 'profile-skills-outsider')
  owners.push(owner, member, outsider)
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  workspaces.push(workspace.id)
  const scope = { ownerId: owner, workspaceId: workspace.id }
  const install = async (userId: string, name: string, body: string, enabled = true) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO personal_skills(id,user_id,name,source,slug,source_kind,source_revision,source_path,body,sha256,enabled)
      VALUES($1,$2,$3,'skills.sh',$4,'skills.sh','rev-1','SKILL.md',$5,$6,$7)`, [id, userId, name, name.toLowerCase(), body, sha(body), enabled])
    return id
  }
  const personalBody = '---\nname: Deploy check\ndescription: Check the deployment path before shipping.\n---\n\nInspect the deploy configuration.\n'
  const personalId = await install(owner, 'Deploy check', personalBody)
  const disabledId = await install(owner, 'Disabled skill', 'Disabled body.\n', false)
  const sharedId = await install(member, 'Shared review', 'Review the frozen candidate independently.\n')
  await pool.query(`INSERT INTO personal_skill_workspace_shares(id,skill_id,workspace_id) VALUES($1,$2,$3)`, [randomUUID(), sharedId, workspace.id])
  const store = new AgentProfileStore(pool)
  // The public Profile view never carries Skill bodies; read the frozen row.
  const rowSkills = async (profileId: string) => {
    const { rows: [row] } = await pool.query<{ skills: Awaited<ReturnType<typeof resolveAgentProfileSkillsFor>> }>('SELECT skills FROM factory_agent_profiles WHERE id=$1', [profileId])
    return row.skills
  }

  await t.test('resolves the owner\'s installation and an explicitly shared workspace Skill, never another owner\'s private one', async () => {
    const skills = await resolveAgentProfileSkillsFor(pool, scope, [`personal:${personalId}`, `workspace:${sharedId}`])
    assert.equal(skills[0].source, 'personal')
    assert.equal(skills[0].content, personalBody.trim())
    assert.equal(skills[0].description, 'Check the deployment path before shipping.')
    assert.equal(skills[0].digest, sha(personalBody))
    assert.equal(skills[1].source, 'workspace')
    assert.equal(skills[1].content, 'Review the frozen candidate independently.')
    await assert.rejects(resolveAgentProfileSkillsFor(pool, scope, [`personal:${sharedId}`]), (error: unknown) =>
      error instanceof AgentProfileError && error.detail === 'missing')
    await assert.rejects(resolveAgentProfileSkillsFor(pool, scope, [`personal:${disabledId}`]), (error: unknown) =>
      error instanceof AgentProfileError && error.detail === 'disabled')
    const catalog = await agentProfileSkillCatalog(pool, scope)
    const item = (id: string) => catalog.find(skill => skill.id === id)
    assert.equal(item(`personal:${personalId}`)?.available, true)
    assert.equal(item(`personal:${personalId}`)?.shareable, true)
    assert.equal(item(`personal:${disabledId}`)?.available, false)
    assert.equal(item(`personal:${disabledId}`)?.reason, 'disabled')
    assert.equal(item(`workspace:${sharedId}`)?.available, true)
    assert.equal(item(`workspace:${sharedId}`)?.shared, true)
    // Another owner's installation is not addressable through this scope.
    assert.equal((await agentProfileSkillCatalog(pool, { ...scope, ownerId: outsider })).some(skill => skill.id.includes(personalId)), false)
  })

  await t.test('a revoked share or an inactive owner stops new use without rewriting the pinned body', async () => {
    const skills = await resolveAgentProfileSkillsFor(pool, scope, [`workspace:${sharedId}`])
    assert.deepEqual(await agentProfileSkillAvailability(pool, scope, skills), { [`workspace:${sharedId}`]: { available: true } })
    await pool.query('DELETE FROM personal_skill_workspace_shares WHERE skill_id=$1 AND workspace_id=$2', [sharedId, workspace.id])
    assert.deepEqual(await agentProfileSkillAvailability(pool, scope, skills), { [`workspace:${sharedId}`]: { available: false, reason: 'missing' } })
    await pool.query(`INSERT INTO personal_skill_workspace_shares(id,skill_id,workspace_id) VALUES($1,$2,$3)`, [randomUUID(), sharedId, workspace.id])
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, member])
    assert.deepEqual(await agentProfileSkillAvailability(pool, scope, skills), { [`workspace:${sharedId}`]: { available: false, reason: 'forbidden' } })
    await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, member])
    assert.deepEqual(await agentProfileSkillAvailability(pool, scope, skills), { [`workspace:${sharedId}`]: { available: true } })
  })

  await t.test('a Profile pins the saved body; editing other fields and source changes never rewrite it', async () => {
    const definition = parseAgentProfile({ name: 'Personal role', roles: ['implementation'], skills: [`personal:${personalId}`], instructions: 'Keep the change small.' })
    const created = await store.create(scope, definition)
    const createdSkills = await rowSkills(created.id)
    assert.equal(createdSkills[0].content, personalBody.trim())
    assert.equal(agentProfileDigest(definition, createdSkills), created.digest)
    // A source edit does not change the saved Profile's pinned envelope.
    const changedBody = 'Changed after the profile was saved.\n'
    await pool.query('UPDATE personal_skills SET body=$2,sha256=$3 WHERE id=$1', [personalId, changedBody, sha(changedBody)])
    const updated = await store.update(scope, created.id, created.version, { ...definition, instructions: 'A revised instruction.' })
    const updatedSkills = await rowSkills(updated.id)
    assert.equal(updatedSkills[0].content, personalBody.trim())
    assert.equal(updatedSkills[0].digest, sha(personalBody))
    assert.notEqual(updated.digest, created.digest)
    // The current source is still authorized; availability does not depend on its bytes.
    assert.deepEqual(await agentProfileSkillAvailability(pool, scope, updatedSkills), { [`personal:${personalId}`]: { available: true } })
    // Removing the reference resolves the new installation again.
    const replaced = await store.update(scope, updated.id, updated.version, { ...definition, skills: [] })
    assert.deepEqual(await rowSkills(replaced.id), [])
    // A disabled source cannot be newly selected or re-resolved into a Profile.
    await assert.rejects(store.create(scope, { ...definition, name: 'Disabled role', skills: [`personal:${disabledId}`] }),
      (error: unknown) => error instanceof AgentProfileError && error.detail === 'disabled')
  })

  await t.test('workspace sharing is an explicit owner action limited to team members', async () => {
    const skills = new WorkspaceSkillStore(pool)
    const page = await skills.share(owner, { workspaceId: workspace.id, skillId: personalId, shared: true })
    assert.equal(page.workspaceKind, 'team')
    assert.equal(page.canShare, true)
    assert.equal(page.skills.find(skill => skill.id === personalId)?.shared, true)
    const memberPage = await skills.list(member, workspace.id)
    const shared = memberPage.skills.find(skill => skill.id === personalId)
    assert.equal(shared?.mine, false)
    assert.equal(shared?.ownerId, owner)
    // Another member cannot share or unshare someone else's installation.
    for (const action of [true, false]) {
      await assert.rejects(skills.share(member, { workspaceId: workspace.id, skillId: personalId, shared: action }),
        (error: unknown) => (error as { code?: string }).code === 'skillNotFound')
    }
    const unshared = await skills.share(owner, { workspaceId: workspace.id, skillId: personalId, shared: false })
    assert.equal(unshared.skills.find(skill => skill.id === personalId)?.shared, false)
    // A personal workspace has no other member to share to.
    const personal = await (await import('../../tests/support/workspace-admin-db')).seedPersonalWorkspace(pool, outsider)
    workspaces.push(personal)
    await assert.rejects(skills.share(outsider, { workspaceId: personal, skillId: sharedId, shared: true }),
      (error: unknown) => (error as { code?: string }).code === 'workspaceAccessDenied')
  })

  await t.test('a Profile with a revoked source is not available for dispatch but its frozen row is unchanged', async () => {
    const definition = parseAgentProfile({ name: 'Shared role', roles: ['review'], skills: [`workspace:${sharedId}`] })
    const created = await store.create(scope, definition)
    const skills = await rowSkills(created.id)
    assert.equal((await agentProfileSkillAvailability(pool, scope, skills))[`workspace:${sharedId}`].available, true)
    await pool.query('DELETE FROM personal_skill_workspace_shares WHERE skill_id=$1 AND workspace_id=$2', [sharedId, workspace.id])
    assert.deepEqual(await agentProfileSkillAvailability(pool, scope, skills), { [`workspace:${sharedId}`]: { available: false, reason: 'missing' } })
    assert.deepEqual(await rowSkills(created.id), skills)
  })
})

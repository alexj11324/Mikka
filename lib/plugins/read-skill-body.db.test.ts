import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { PersonalPluginStore } from './store'
import type { SkillContent } from './contracts'

// ALE-75 completion condition: "`read_personal_skill` 注册且可调用，读的是
// `personal_skills` 表".
//
// The distinction that matters: `load_skill` reads
// `execution.snapshot.definition.skills`, the agent-kit definition, which is
// empty for everyone who installed skills in the personal plugin store. This
// method must read the table. A test that only asserted "a body comes back"
// could pass against either source, so these assert the source directly, and
// the isolation that a table read has to get right — another person's row,
// and a switched-off row, must not be served.

const databaseURL = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw Error('Personal plugin database tests require E2E_DATABASE_URL')

const body = (marker: string) => `---\ndescription: ${marker} skill\n---\n${marker} instructions, at length.`

test('readSkillBody reads personal_skills, and only the caller\'s enabled rows', { skip: !databaseURL }, async () => {
  const url = new URL(databaseURL!)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.endsWith('_e2e') && !url.search && !url.hash, 'Explicit isolated loopback E2E database required')
  const schema = `skillbody_${randomBytes(8).toString('hex')}`
  const admin = new Pool({ connectionString: databaseURL }), pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  await admin.query(`CREATE SCHEMA ${schema}`)
  try {
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES('owner'),('peer'); CREATE TABLE workspace_app_policies(app text CHECK(app IN ('gmail','notion'))); CREATE TABLE composio_accounts("userId" text,toolkit text)`)
    const migration = await readFile(new URL('../../drizzle/20261031040000_personal_plugins.sql', import.meta.url), 'utf8')
    await pool.query(migration)
    const store = new PersonalPluginStore(pool, { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
    const install = (owner: string, marker: string): Promise<unknown> => store.installSkill(owner, {
      name: `${marker}-skill`, source: 'owner/repo', slug: `${marker}-slug`, sourceKind: 'skills.sh',
      sourceRevision: 'a'.repeat(40), sourcePath: 'SKILL.md', sha256: 'b'.repeat(64), body: body(marker),
    } as SkillContent)
    await install('owner', 'OWNER')
    await install('peer', 'PEER')

    const ownerSkills = await store.listSkills('owner')
    assert.equal(ownerSkills.length, 1)
    const id = ownerSkills[0].id

    // The body comes from the table, whole.
    const read = await store.readSkillBody('owner', id)
    assert.ok(read, 'the owner reads their own skill')
    assert.equal(read.id, id)
    assert.equal(read.body, body('OWNER'))

    // The source is the table, not a definition: the same id read as the
    // person who did not install it yields nothing.
    assert.equal(await store.readSkillBody('peer', id), null, 'another person cannot read this row by id')
    const peerId = (await store.listSkills('peer'))[0].id
    assert.notEqual(peerId, id)
    assert.equal((await store.readSkillBody('peer', peerId))!.body, body('PEER'))

    // A switched-off skill is not served: the prompt's snapshot filtered on
    // enabled when the round began, but a fetch is a read of now.
    await store.updateSkill('owner', id, false)
    assert.equal(await store.readSkillBody('owner', id), null, 'a disabled skill is not served')

    // And an unknown id is null rather than a thrown error, so the tool can
    // answer skillNotInstalled instead of failing the round.
    assert.equal(await store.readSkillBody('owner', '00000000-0000-4000-8000-000000000000'), null)
  } finally {
    pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); admin.end()
  }
})

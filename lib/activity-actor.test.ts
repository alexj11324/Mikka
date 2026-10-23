import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { actingContext, activityActor, agentActor, systemActor, userActor } from './activity-actor'

test('a signed-in write records the person as the actor', () => {
  assert.deepEqual(activityActor('u1'), { actorType: 'user', actorId: 'u1' })
})

test('an MCP agent acting for the person is recorded as the agent', async () => {
  await actingContext.run({ userId: 'u1', actor: agentActor('client-1') }, async () => {
    await Promise.resolve()
    assert.deepEqual(activityActor('u1'), { actorType: 'agent', actorId: 'client-1' })
  })
  assert.deepEqual(activityActor('u1'), userActor('u1'), 'context does not leak out of actAs')
})

test('actAs without an actor still records the person', async () => {
  await actingContext.run({ userId: 'u1' }, async () => assert.deepEqual(activityActor('u1'), userActor('u1')))
})

test('the agent actor only applies to the user it acts for', async () => {
  await actingContext.run({ userId: 'u1', actor: agentActor('client-1') }, async () => assert.deepEqual(activityActor('u2'), userActor('u2')))
})

test('system actor', () => {
  assert.deepEqual(systemActor('linear'), { actorType: 'system', actorId: 'linear' })
})

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !name.endsWith('.test.ts') ? [path] : []
  })
}

test('every issue_versions insert on the server sets the actor', () => {
  const writes = ['app', 'lib'].flatMap(sources).flatMap(path => {
    const text = readFileSync(path, 'utf8')
    return [...text.matchAll(/insert\(issueVersions\)\.values\(\{/g)].map(match => {
      const end = text.indexOf('})', match.index)
      return { path, body: text.slice(match.index, end) }
    })
  })
  assert.ok(writes.length >= 8, `found ${writes.length} writes`)
  for (const write of writes) assert.match(write.body, /\.\.\.(activityActor|systemActor|userActor|agentActor|actor)\b/, `${write.path} writes issue_versions without an actor`)
})

test('the migration is timestamp-named, later than 20261023040300, and idempotent', () => {
  const name = readdirSync('drizzle').find(file => file.endsWith('_activity_version_actor.sql'))!
  assert.match(name, /^\d{14}_/)
  assert.ok(name.slice(0, 14) > '20261023040300')
  const sql = readFileSync(join('drizzle', name), 'utf8')
  assert.equal((sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length, 2)
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/)
})

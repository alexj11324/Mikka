import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from './helpers/task-workspace'
import { mentionAt, personReferenceParts, referenceMarker } from '../lib/thread-references'

test('an inline mention replaces only the active word at the caret and keeps unrelated human text literal', () => {
  const text = 'Please see @thread:checkout and the log'
  assert.deepEqual(mentionAt(text, text.indexOf(' and')), { from: 11, end: 27, kind: 'thread', query: 'checkout' })
  assert.equal(mentionAt('mail@example', 12), null)
  const id = randomUUID()
  const marker = referenceMarker({ kind: 'thread', id, title: 'Checkout' })
  assert.deepEqual(personReferenceParts(`ref ${marker} ${id}`), [
    { kind: 'text', text: 'ref ' }, { kind: 'thread', id }, { kind: 'text', text: ' ' }, { kind: 'text', text: id },
  ])
  assert.deepEqual(personReferenceParts('https://github.com/org/repo/pull/2'), [{ kind: 'pr', id: 'https://github.com/org/repo/pull/2' }])
  assert.equal(personReferenceParts('https://github.com.example/org/repo/pull/2')[0].kind, 'text')
})

test('reference search scopes tasks, conversation roots, and PRs to the active viewer and workspace', { skip: !disposableDatabase(), timeout: 120_000 }, async () => {
  const { pool } = await import('../lib/db')
  const { searchThreadReferences } = await import('../lib/thread-reference-search')
  const owner = 'mention-' + randomUUID(), other = 'mention-' + randomUUID()
  const issue = randomUUID(), agent = randomUUID(), run = randomUUID(), url = 'https://github.com/test/mikka/pull/2259'
  try {
    for (const user of [owner, other]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    const workspace = await seedFixtureWorkspace(pool, owner)
    const foreign = await seedFixtureWorkspace(pool, other)
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState")
      VALUES ($1,$2,'Checkout data',$3,'doing','normal',$4,'bound')`, [issue, owner, JSON.stringify({ type: 'doc', attrs: { mikka: { pullRequests: [{ url, title: 'Checkout fix', state: 'open' }] } } }), workspace])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness) VALUES ($1,$2,'Coding','codex')`, [agent, owner])
    await pool.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId",status,prompt,"promptTaskStart","promptTaskLength",title,"titleSource")
      VALUES ($1,$2,$3,$4,$5,'running','Checkout',0,8,'Checkout','manual')`, [run, owner, workspace, issue, agent])
    const items = await searchThreadReferences(owner, workspace, 'checkout')
    assert.deepEqual(items.map(item => [item.kind, item.id]), [['task', issue], ['thread', run], ['pr', url]])
    assert.deepEqual((await searchThreadReferences(owner, workspace, '#2259', 'pr')).map(item => item.id), [url])
    assert.deepEqual(await searchThreadReferences(other, foreign, 'checkout'), [])
    await assert.rejects(searchThreadReferences(other, workspace, 'checkout'))
    await pool.query(`UPDATE issues SET content=jsonb_set(content,'{attrs,mikka,deletedAt}',to_jsonb(now())) WHERE id=$1`, [issue])
    assert.deepEqual(await searchThreadReferences(owner, workspace, 'checkout'), [])
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [run])
    await pool.query('DELETE FROM issues WHERE id=$1', [issue])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=ANY($1)', [[owner, other]])
    await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=ANY($1)', [[owner, other]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, other]])
  }
})

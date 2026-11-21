import assert from 'node:assert/strict'
import test from 'node:test'
import { WORKSPACE_BOT_MODELS, type WorkspaceBotModel } from './bot-models'

/**
 * One list, three readers: the conversations CHECK constraint in
 * drizzle/20261118120000, the strict create schema in lib/group-conversations-store.ts,
 * and the create dialog's picker. A name added here without a migration, or the
 * reverse, breaks a create at runtime instead of here.
 */
test('the pinned models are the three the schema and the API accept', () => {
  assert.deepEqual([...WORKSPACE_BOT_MODELS], ['mikka', 'codex', 'claude'])
  const typed: WorkspaceBotModel[] = [...WORKSPACE_BOT_MODELS]
  assert.equal(new Set(typed).size, typed.length, 'no duplicates')
})

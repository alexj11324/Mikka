import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { afterCommit, hasCommitEffect, observeCommitEffects } from './commit-effects'

function client() {
  let nextError: Error | null = null
  let nextCommand: string | null = null
  const query = (...args: unknown[]) => {
    const input = args[0]
    const text = typeof input === 'string' ? input : (input as { text: string }).text
    const result = { command: nextCommand ?? text.trim().split(/\s/)[0].toUpperCase(), rows: [], rowCount: 0 }
    const error = nextError
    nextError = null; nextCommand = null
    const callback = args.at(-1)
    if (typeof callback === 'function') { queueMicrotask(() => callback(error, result)); return undefined }
    return error ? Promise.reject(error) : Promise.resolve(result)
  }
  const value = { query } as unknown as PoolClient
  observeCommitEffects(value)
  return { value, fail: (error: Error) => { nextError = error }, command: (command: string) => { nextCommand = command } }
}

test('a composed writer waits for the outer commit and coalesces repeated entity changes', async () => {
  const { value } = client(), sent: string[] = []
  await value.query('BEGIN')
  afterCommit(value, 'task', () => { sent.push('old') })
  afterCommit(value, 'task', () => { sent.push('current') })
  assert.equal(hasCommitEffect(value, 'task'), true)
  assert.deepEqual(sent, [])
  await value.query('COMMIT')
  assert.deepEqual(sent, ['current'])
  assert.equal(hasCommitEffect(value, 'task'), false)
})

test('rollback and PostgreSQL COMMIT-as-ROLLBACK never publish', async () => {
  const c = client(), sent: string[] = []
  for (const command of ['ROLLBACK', 'COMMIT']) {
    await c.value.query('BEGIN')
    afterCommit(c.value, 'task', () => { sent.push('leaked') })
    if (command === 'COMMIT') c.command('ROLLBACK')
    await c.value.query(command)
  }
  assert.deepEqual(sent, [])
})

test('savepoint rollback removes only the reverted changes, including replacements of an earlier key', async () => {
  const { value } = client(), sent: string[] = []
  await value.query('begin')
  afterCommit(value, 'before', () => { sent.push('before') })
  await value.query('SAVEPOINT retry')
  afterCommit(value, 'before', () => { sent.push('replaced') })
  afterCommit(value, 'reverted', () => { sent.push('reverted') })
  await value.query('SAVEPOINT nested')
  afterCommit(value, 'nested', () => { sent.push('nested') })
  await value.query('ROLLBACK TO SAVEPOINT retry')
  assert.equal(hasCommitEffect(value, 'reverted'), false)
  afterCommit(value, 'after', () => { sent.push('after') })
  await value.query('RELEASE SAVEPOINT retry')
  await value.query('commit')
  assert.deepEqual(sent, ['before', 'after'])
})

test('a failed commit cannot leave effects for a later transaction', async () => {
  const c = client(), sent: string[] = []
  await c.value.query('BEGIN')
  afterCommit(c.value, 'task', () => { sent.push('failed') })
  const failure = new Error('connection lost')
  c.fail(failure)
  await assert.rejects(c.value.query('COMMIT'), error => error === failure)
  await c.value.query('ROLLBACK')
  await c.value.query('BEGIN')
  await c.value.query('COMMIT')
  assert.deepEqual(sent, [])
})

test('callback query semantics and query-config objects remain supported', async () => {
  const { value } = client(), sent: string[] = []
  await value.query({ text: 'BEGIN' })
  afterCommit(value, 'task', () => { sent.push('committed') })
  await new Promise<void>((resolve, reject) => value.query('COMMIT', error => error ? reject(error) : resolve()))
  assert.deepEqual(sent, ['committed'])
})

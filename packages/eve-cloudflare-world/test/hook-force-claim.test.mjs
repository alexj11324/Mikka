import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { HookForceClaimedError } from '@workflow/errors'
import { applyWorldEvent, initializeWorldStorage, listEvents, readHookById, readHookByToken } from '../src/admission.mjs'
import { createNodeWorld } from '../src/node-world.mjs'
import { decodeRecord, encodeRecord } from '../src/records.mjs'

test('force claims preserve SDK wake receipts and redirect stale deliveries across the private transport', async () => {
  const database = new DatabaseSync(':memory:')
  const storage = {
    sql: { exec(query, ...bindings) {
      if (/;\s*\S/.test(query)) {
        database.exec(query)
        return { toArray: () => [] }
      }
      const statement = database.prepare(query)
      const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value)
      if (statement.columns().length) return { toArray: () => statement.all(...values) }
      const result = statement.run(...values)
      return { toArray: () => [], rowsWritten: Number(result.changes) }
    } },
    transactionSync(callback) {
      database.exec('BEGIN')
      try {
        const result = callback()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
  initializeWorldStorage(storage)
  const world = createNodeWorld({ deploymentId: 'aaa1111-10-1', async fetchBound(url, options) {
    expect(String(url)).toBe('https://world.internal/world/rpc')
    const [method, ...args] = decodeRecord(options.body)
    let result
    if (method === 'create') result = applyWorldEvent(storage, args[0], args[1], Date.now(), args[2])
    else if (method === 'hook') result = readHookById(storage, args[0])
    else if (method === 'hookByToken') result = readHookByToken(storage, args[0])
    else if (method === 'events') result = listEvents(storage, args[0], args[1], args[2])
    else throw new Error('Unexpected fixture RPC method')
    return new Response(encodeRecord(result))
  } })
  const create = (runId, eventType, correlationId, eventData, options) => world.events.create(runId,
    { specVersion: 8, eventType, ...(correlationId ? { correlationId } : {}), ...(eventData ? { eventData } : {}) }, options)
  const start = async (deploymentId, specVersion = 8) => {
    const { run } = await world.events.create(null, { specVersion, eventType: 'run_created', eventData: {
      workflowName: 'workflow//eve//session', deploymentId, input: Uint8Array.of(1),
    } })
    await create(run.runId, 'run_started')
    return run.runId
  }
  try {
    const owner = await start('aaa1111-10-1')
    const claimer = await start('bbb2222-11-1')
    const token = 'session-command-fixture'
    await create(owner, 'hook_created', 'hook_owner', { token })
    const accepted = await create(owner, 'hook_received', 'hook_owner', { token, payload: Uint8Array.of(2) }, { resumeId: 'accepted' })
    const forced = await create(claimer, 'hook_created', 'hook_claimer', { token, force: true })
    const receipt = { runId: owner, hookId: 'hook_owner', workflowName: 'workflow//eve//session',
      deploymentId: 'aaa1111-10-1', runSpecVersion: 8 }
    expect(forced.hook.claimedFrom).toEqual(receipt)
    expect(forced.event.eventData.forceClaimedFrom).toEqual(receipt)
    expect((await world.hooks.getByToken(token)).claimedFrom).toEqual(receipt)
    expect((await world.hooks.get('hook_claimer', { resolveData: 'none' })).claimedFrom).toEqual(receipt)
    expect((await world.events.list({ runId: claimer })).data.at(-1).eventData.forceClaimedFrom).toEqual(receipt)
    expect((await world.events.list({ runId: owner })).data.at(-1).eventData.forceClaimedBy).toEqual({ runId: claimer, hookId: 'hook_claimer' })
    expect(world.capabilities.hookForceClaim).toBe(true)
    await create(owner, 'run_completed', undefined, { output: Uint8Array.of(3) })
    const successor = await start('ccc3333-12-1')
    await create(successor, 'hook_created', 'hook_successor', { token, force: true })
    await expect(create(owner, 'hook_received', 'hook_owner', { token, payload: Uint8Array.of(4) }, { resumeId: 'stale' }))
      .rejects.toMatchObject({ name: 'HookForceClaimedError', token, claimedByRunId: claimer, claimedByHookId: 'hook_claimer' })
    await expect(create(claimer, 'hook_received', 'hook_claimer', { token, payload: Uint8Array.of(4) }))
      .rejects.toSatisfy(HookForceClaimedError.is)
    await expect(create(claimer, 'hook_received', 'hook_claimer', { payload: Uint8Array.of(4) }))
      .rejects.toMatchObject({ name: 'HookForceClaimedError', token, claimedByRunId: successor })
    await expect(create(claimer, 'hook_received', 'hook_claimer', { token: 'different', payload: Uint8Array.of(4) }))
      .rejects.toMatchObject({ name: 'HookNotFoundError' })
    expect((await create(owner, 'hook_received', 'hook_owner', { token, payload: Uint8Array.of(2) }, { resumeId: 'accepted' })).event.eventId).toBe(accepted.event.eventId)
    await expect(create(claimer, 'hook_created', 'hook_claimer', { token, force: true })).rejects.toMatchObject({ name: 'EntityConflictError' })
    expect((await world.hooks.getByToken(token)).runId).toBe(successor)
    const oldOwner = await start('ddd4444-13-1', 7)
    await create(oldOwner, 'hook_created', 'hook_old', { token: 'pre-v8' })
    expect((await create(successor, 'hook_created', 'hook_declined', { token: 'pre-v8', force: true })).event)
      .toMatchObject({ eventType: 'hook_conflict', eventData: { token: 'pre-v8', conflictingRunId: oldOwner, forceRefusedReason: 'victim-spec-version' } })
    expect((await world.hooks.getByToken('pre-v8')).runId).toBe(oldOwner)
    const free = await create(successor, 'hook_created', 'hook_free', { token: 'free', force: true,
      claimedFrom: receipt, forceClaimedFrom: receipt })
    expect(free.hook.claimedFrom).toBeUndefined()
    expect(free.event.eventData.forceClaimedFrom).toBeUndefined()
  } finally {
    database.close()
  }
})

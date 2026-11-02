import assert from 'node:assert/strict'
import test from 'node:test'
import { recoverInterruptedTurns } from './interrupted-turns'

test('a lease held by an ended run is let go and its message retried; a live or unreadable run is left alone', async () => {
  const statuses: Record<string, string | Error> = { wrun_failed: 'failed', wrun_cancelled: 'cancelled', wrun_done: 'completed', wrun_live: 'running', wrun_unknown: new Error('world unavailable') }
  const released: string[] = [], retried: string[] = []
  const counts = await recoverInterruptedTurns({
    leased: async () => Object.keys(statuses).map(holder => ({ userId: 'owner', botId: `bot-${holder}`, holder })),
    status: async holder => { const status = statuses[holder]; if (status instanceof Error) throw status; return status },
    release: async (_userId, holder) => { released.push(holder) },
    // A run that had already stored its reply has nothing to retry.
    retry: async (_userId, botId) => { retried.push(botId); return botId !== 'bot-wrun_done' },
  })
  assert.deepEqual(released, ['wrun_failed', 'wrun_cancelled', 'wrun_done'])
  assert.deepEqual(retried, ['bot-wrun_failed', 'bot-wrun_cancelled', 'bot-wrun_done'])
  assert.deepEqual(counts, { checked: 5, recovered: 3, retried: 2 })
})

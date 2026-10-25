import { Pool } from 'pg'
import { CoordinatorInbox, isolatedInboxOptions, controlledEffect } from '../../lib/coordinator/wake-test-helpers'
async function main() {
  const url = process.env.WAKE_TEST_DATABASE_URL
  if (!url || new URL(url).hostname !== '127.0.0.1' || !new URL(url).pathname.endsWith('_176'))
    throw new Error('isolated wake PG required')
  const pool = new Pool({ connectionString: url }),
    members = new Pool({ connectionString: url })
  const input = JSON.parse(process.env.WAKE_CHILD_INPUT!)
  const inbox = new CoordinatorInbox(
    pool,
    isolatedInboxOptions(pool, members, () => new Date(input.clock)),
  )
  const receipt = await inbox.take(input.owner, input.holder, input.delivery)
  if (!receipt.held) throw new Error('fixture lease unavailable')
  if (input.phase === 'effect' || input.phase === 'checkpoint') {
    await inbox.beginGeneration(input.owner, input.holder, input.delivery)
    await controlledEffect(pool, receipt.operationId!)
  }
  if (input.phase === 'checkpoint')
    await inbox.checkpoint(input.owner, input.holder, input.delivery, [
      { role: 'assistant', content: 'CONTROLLED CHECKPOINT, NOT A MODEL' },
    ])
  process.stdout.write(JSON.stringify({ phase: input.phase, receipt }) + '\n')
  process.stdin.resume()
}
main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})

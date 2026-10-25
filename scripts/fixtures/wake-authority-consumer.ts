import { Pool } from 'pg'
import { registerHooks } from 'node:module'
import { CoordinatorInbox } from '../../lib/coordinator/inbox-receipts'
async function main() {
  const url = process.env.WAKE_REVIEW_TEST_DATABASE_URL
  if (!url || new URL(url).hostname !== '127.0.0.1' || !new URL(url).pathname.endsWith('_176'))
    throw new Error('isolated authority fixture only')
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'server-only'
        ? { url: 'data:text/javascript,export{}', shortCircuit: true }
        : next(specifier, context)
    },
  })
  const input = JSON.parse(process.env.WAKE_CHILD_INPUT!)
  const { coordinatorInboxOptions } = await import('../../lib/coordinator/inbox-runtime')
  const pool = new Pool({ connectionString: url })
  const inbox = new CoordinatorInbox(pool, {
    ...coordinatorInboxOptions(),
    clock: () => new Date(input.clock),
    leaseMs: 1000,
  })
  const receipt = await inbox.take(input.owner, input.holder, input.delivery)
  process.stdout.write(
    JSON.stringify({
      phase: 'actual authority staged',
      held: receipt.held,
      added: receipt.added,
      operationId: receipt.operationId,
    }) + '\n',
  )
  hooks.deregister()
  process.stdin.resume()
}
main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})

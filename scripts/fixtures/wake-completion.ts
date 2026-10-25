import { Pool } from 'pg'
import { SessionMailbox } from '../../lib/session-mailbox'

async function main() {
  const url = process.env.WAKE_TEST_DATABASE_URL
  if (!url || new URL(url).hostname !== '127.0.0.1' || !new URL(url).pathname.endsWith('_176'))
    throw new Error('isolated database required')
  const input = JSON.parse(process.env.WAKE_COMPLETION_INPUT!) as {
    owner: string
    runId: string
    workspace: string
    phase: string
  }
  const pool = new Pool({ connectionString: url }),
    tx = await pool.connect()
  await tx.query('BEGIN')
  await new SessionMailbox(pool, input.workspace).complete(
    input.owner,
    input.runId,
    'succeeded',
    'submitted',
    { summary: 'Actual isolated completion transaction; no harness or model invoked.' },
    tx,
  )
  if (input.phase === 'after_commit') await tx.query('COMMIT')
  process.stdout.write(JSON.stringify({ phase: input.phase, runId: input.runId }) + '\n')
  process.stdin.resume()
}
main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})

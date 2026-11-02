import assert from 'node:assert/strict'
import test from 'node:test'
import { readWorkerTail, saveWorkerTail, workerCommand, workerOutputForwarder, TAIL_MAX, WORKER_LOG } from './thread-worker-logs'

const mask = (text: string) => text.replaceAll('sekret', '[secret:TOKEN]')

test('worker output reaches the server log line by line, masked, bounded and split across chunks', () => {
  const lines: Record<string, string>[] = []
  const { onStdout, onStderr } = workerOutputForwarder('run-1', mask, line => lines.push(JSON.parse(line)))
  onStdout('daemon started\nclaim run-1 uses sekret')
  onStdout(' value\n\n')
  onStderr(`${'x'.repeat(900)}\n`)
  assert.deepEqual(lines.map(line => [line.event, line.runId, line.stream, line.line.length < 100 ? line.line : `len:${line.line.length}`]), [
    ['thread_worker_output', 'run-1', 'stdout', 'daemon started'],
    ['thread_worker_output', 'run-1', 'stdout', 'claim run-1 uses [secret:TOKEN] value'],
    ['thread_worker_output', 'run-1', 'stderr', 'len:500'],
  ])
})

test('a chatty worker is cut off after a bounded number of lines, with one notice', () => {
  const lines: string[] = []
  const { onStdout } = workerOutputForwarder('run-2', mask, line => lines.push(line))
  onStdout(Array.from({ length: 700 }, (_, i) => `line ${i}`).join('\n') + '\n')
  assert.equal(lines.length, 501)
  assert.match(lines[500], /further output kept in the sandbox log only/)
})

test('the worker command keeps streaming and appends to the sandbox log', () => {
  assert.equal(workerCommand('run-worker'), `{ run-worker; } 2>&1 | tee -a ${WORKER_LOG}`)
})

test('the tail is read back bounded; a failing or hanging read gives null without throwing', async () => {
  const commands: string[] = []
  const box = (stdout: string) => async () => ({ commands: { run: async (cmd: string) => { commands.push(cmd); return { stdout } } } })
  assert.equal(await readWorkerTail(box('worker said hi\n')), 'worker said hi')
  assert.match(commands[0], /tail -n 200 \/home\/user\/\.mikka\/thread-bootstrap\.log/)
  assert.equal((await readWorkerTail(box('y'.repeat(TAIL_MAX * 2))))!.length, TAIL_MAX)
  assert.equal(await readWorkerTail(box('   \n')), null)
  assert.equal(await readWorkerTail(async () => { throw new Error('sandbox gone') }), null)
  const started = Date.now()
  assert.equal(await readWorkerTail(() => new Promise(() => {}), 50), null)
  assert.ok(Date.now() - started < 1000, 'a hung read gives up at its timeout')
})

test('the tail is saved masked with the machine; as an error only where the run has none', async () => {
  const calls: [string, unknown[]][] = []
  const query = { query: async (sql: string, values: unknown[]) => { calls.push([sql, values]); return { rows: [], rowCount: 1 } } } as never
  await saveWorkerTail(query, 'run-3', null, mask, 'ignored')
  assert.equal(calls.length, 0, 'nothing read, nothing written')
  await saveWorkerTail(query, 'run-3', 'boom sekret', mask)
  await saveWorkerTail(query, 'run-3', 'boom sekret', mask, 'Thread worker did not register')
  assert.deepEqual(calls.map(([sql, values]) => [sql.split(' WHERE')[0], values]), [
    ['UPDATE thread_machines SET "logTail"=$2', ['run-3', 'boom [secret:TOKEN]']],
    ['UPDATE thread_machines SET "logTail"=$2', ['run-3', 'boom [secret:TOKEN]']],
    ['UPDATE agent_runs SET error=$2', ['run-3', 'Thread worker did not register\nboom [secret:TOKEN]']],
  ])
  assert.match(calls[2][0], /error IS NULL/, 'an existing error is never overwritten')
})

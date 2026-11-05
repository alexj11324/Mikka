import { createRequire } from 'node:module'
import { readFile, readdir, writeFile } from 'node:fs/promises'
const root = '/vercel/sandbox/mikka-wake-deadline'
const require = createRequire(`${root}/package.json`)
const { start, getRun } = await import(require.resolve('workflow/api'))
const { getWorld } = await import(require.resolve('workflow/runtime'))
const [mode, path] = process.argv.slice(2)
const receipt = JSON.parse(await readFile(path, 'utf8'))
if (mode === 'start') {
  const run = await start({ workflowId: receipt.workflowId }, [receipt.ticket])
  receipt.runId = run.runId
  receipt.startReturnedAt = new Date().toISOString()
  await writeFile(path, JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ mode, runId: run.runId }))
  // Keep this queue-owning process alive until the parent deliberately kills it.
  setInterval(() => {}, 1000)
} else if (mode === 'resume') {
  await (await getWorld()).start()
  const run = getRun(receipt.runId)
  const until = Date.now() + 150_000
  while (Date.now() < until) {
    const status = await run.status
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      receipt.finalStatus = status
      receipt.finalObservedAt = new Date().toISOString()
      await writeFile(path, JSON.stringify(receipt, null, 2))
      if (status !== 'completed') throw new Error(`unexpected_terminal_status:${status}`)
      await run.returnValue
      // Local World writes the run projection before it publishes the terminal
      // event. Keep this queue owner alive until that real write is durable.
      const eventDir = `${process.env.WORKFLOW_LOCAL_DATA_DIR}/events/${receipt.runId}`
      let terminal = false
      const flushBy = Date.now() + 10_000
      while (!terminal && Date.now() < flushBy) {
        for (const name of await readdir(eventDir)) {
          if (!name.endsWith('.json')) continue
          const value = JSON.parse(await readFile(`${eventDir}/${name}`, 'utf8'))
          if (value.eventType === 'run_completed') terminal = true
        }
        if (!terminal) await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (!terminal) throw new Error('terminal_event_not_persisted')
      console.log(JSON.stringify({ mode, runId: receipt.runId, status }))
      process.exit(0)
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('runtime_completion_timeout')
} else throw new Error('unknown_stage')

import { writeFile } from 'node:fs/promises'
import { AUDIENCE, validJob } from '../cloudflare/engineering-sandbox/jobs.mjs'

// This client runs in the repository's trusted Actions workflow. Candidate files
// execute only in the Container. No Cloudflare admin token is needed to run a job.
const endpoint = 'https://mikka-engineering-sandbox.orvilo-preview.workers.dev'
async function request(path, job) {
  const tokenUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
  tokenUrl.searchParams.set('audience', AUDIENCE)
  const identity = await fetch(tokenUrl, {
    headers: { authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  })
  if (!identity.ok) throw new Error('Actions identity HTTP ' + identity.status)
  const { value } = await identity.json()
  if (!value) throw new Error('Actions identity unavailable')
  const url = new URL(path, endpoint)
  url.searchParams.set('workload', workload)
  const response = await fetch(url, {
    method: path === '/receipt' ? 'GET' : 'POST', redirect: 'error',
    headers: { authorization: 'Bearer ' + value, 'content-type': 'application/json' },
    body: job ? JSON.stringify(job) : undefined, signal: AbortSignal.timeout(11 * 60_000),
  })
  if (!response.ok) throw new Error('Engineering sandbox ' + path + ' HTTP ' + response.status)
  return response.json()
}

const [action, workload, issue, sha] = process.argv.slice(2)
if (!['run', 'cancel', 'receipt'].includes(action)) throw new Error('Expected run, cancel or receipt')
const job = { workload, issue: Number(issue), sha }
if (action === 'run' && !validJob(job)) throw new Error('Expected a supported workload, positive issue and full Git SHA')
if (action === 'run') {
  let cancelling = false
  async function cancel() {
    if (cancelling) return
    cancelling = true
    try { await request('/cancel') }
    catch (error) { console.error('Engineering sandbox cancellation:', error.message) }
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
}
const receipt = await request('/' + action, action === 'run' ? job : undefined)
const path = process.env.RUNNER_TEMP + '/engineering-receipt.json'
await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
// Candidate-controlled TAP stays in the artifact, outside the Actions command parser.
console.log(JSON.stringify({ state: receipt.state, requestedAt: receipt.requestedAt, stoppedAt: receipt.stoppedAt, source: job.sha }))
if (action === 'run' && receipt.state !== 'passed') process.exitCode = 1

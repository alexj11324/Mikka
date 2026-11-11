import { DurableObject } from 'cloudflare:workers'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { AUDIENCE, DEADLINE_MS, RECEIPT_MS, githubRun, jobs, sourceFiles, validJob } from './jobs.mjs'
import command from './command.txt'

const issuer = 'https://token.actions.githubusercontent.com'
const keys = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks'))
const maximumConcurrent = 2

// One account-wide admission object. A slot is released after the owning
// execution confirms stop. A failed cleanup keeps the slot and retries by alarm.
export class EngineeringCapacity extends DurableObject {
  async acquire(owner) {
    return this.ctx.storage.transaction(async transaction => {
      const slots = await transaction.list({ prefix: 'slot:' })
      if (slots.has('slot:' + owner)) return true
      if (slots.size >= maximumConcurrent) return false
      await transaction.put('slot:' + owner, true)
      return true
    })
  }
  async release(owner) {
    await this.ctx.storage.delete('slot:' + owner)
  }
}

export class EngineeringRun extends DurableObject {
  capacity() { return this.env.CAPACITY.getByName('engineering') }
  async begin(job) {
    const claim = await this.ctx.blockConcurrencyWhile(async () => {
      const previous = await this.ctx.storage.get('run')
      if (previous) {
        if (previous.job && ['owner', 'workload', 'sha', 'issue'].some(key => previous.job[key] !== job[key])) {
          return { status: 409, message: 'run already identifies a different job' }
        }
        return { status: previous.state === 'active' ? 409 : 200, receipt: previous }
      }
      const now = Date.now()
      // A crash during admission must leave a wake that can release this slot.
      await this.ctx.storage.setAlarm(now + DEADLINE_MS)
      await this.ctx.storage.put('run', { job, state: 'active', requestedAt: now, deadline: now + DEADLINE_MS })
      if (await this.capacity().acquire(job.owner)) return null
      await this.ctx.storage.delete('run')
      await this.ctx.storage.deleteAlarm()
      return { status: 429, message: 'both engineering containers are in use' }
    })
    if (claim) return claim
    let result
    try {
      const files = await sourceFiles(job)
      const run = await this.ctx.storage.get('run')
      if (run.state !== 'active') return { status: 200, receipt: run }
      const remaining = run.deadline - Date.now()
      if (remaining <= 0) return this.finish('deadline')
      const container = this.ctx.container
      if (!container) throw new Error('engineering container binding unavailable')
      container.start({
        image: 'cloudflare/debian-trixie', instance: 'lite', enableInternet: false,
        entrypoint: ['node', '-e', 'setTimeout(() => {}, ' + remaining + ')'],
      })
      await container.setInactivityTimeout(30_000)
      const body = new Response(JSON.stringify({ files })).body
      const proc = await container.exec(['node', '--input-type=module', '-e', command], { stdin: body })
      const output = await proc.output()
      if (output.exitCode !== 0) throw new Error('container test driver exited ' + output.exitCode)
      result = JSON.parse(new TextDecoder().decode(output.stdout))
      return this.finish(result.exitCode === 0 ? 'passed' : 'failed', { result })
    } catch (error) {
      return this.finish('failed', { cause: String(error).slice(0, 1000) })
    }
  }
  async finish(state, details = {}) {
    // In-flight task completion, cancellation and an alarm can arrive together.
    // A unique DO owns each Actions attempt, so cleanup cannot stop another run.
    if (this.finishing) return this.finishing
    const settled = this.finalize(state, details)
    this.finishing = settled
    try { return await settled } finally { this.finishing = null }
  }
  async finalize(state, details) {
    let run = await this.ctx.storage.get('run')
    if (run?.stoppedAt) return { status: 200, receipt: run }
    if (run?.state !== 'stopping') {
      run = { ...run, ...details, state: 'stopping', outcome: state, settledAt: Date.now() }
      await this.ctx.storage.put('run', run)
    }
    // Make the result durable first. An alarm can finish cleanup after a crash.
    await this.ctx.storage.setAlarm(Date.now() + 30_000)
    const container = this.ctx.container
    if (container?.running) await container.destroy()
    if (container?.running) throw new Error('engineering container stop unconfirmed')
    if (run.job) await this.capacity().release(run.job.owner)
    const receipt = { ...run, state: run.outcome, stoppedAt: Date.now() }
    await this.ctx.storage.put('run', receipt)
    await this.ctx.storage.setAlarm(receipt.stoppedAt + RECEIPT_MS)
    return { status: 200, receipt }
  }
  async receipt() {
    const receipt = await this.ctx.storage.get('run')
    return receipt ? { status: 200, receipt } : { status: 404, message: 'engineering run not found' }
  }
  async alarm() {
    const run = await this.ctx.storage.get('run')
    if (!run) return
    if (!run.stoppedAt) {
      await this.finish('deadline')
    } else if (Date.now() >= run.stoppedAt + RECEIPT_MS) {
      await this.ctx.storage.deleteAll()
    } else {
      await this.ctx.storage.setAlarm(run.stoppedAt + RECEIPT_MS)
    }
  }
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url)
    const method = { '/run': 'POST', '/cancel': 'POST', '/receipt': 'GET' }[pathname]
    if (!method || method !== request.method) return new Response(null, { status: 404 })
    const header = request.headers.get('authorization') ?? ''
    if (!header.startsWith('Bearer ') || header.length > 16_384) return new Response(null, { status: 401 })
    let owner
    try {
      const { payload } = await jwtVerify(header.slice(7), keys, {
        issuer, audience: AUDIENCE, algorithms: ['RS256'], requiredClaims: ['iat', 'exp', 'sub'],
      })
      owner = githubRun(payload)
    } catch {
      return new Response(null, { status: 401 })
    }
    if (!owner) return new Response(null, { status: 403 })
    const workload = searchParams.get('workload')
    if (!Object.hasOwn(jobs, workload)) return new Response(null, { status: 400 })
    owner += '/' + workload
    const run = env.RUNS.getByName(owner)
    let reply
    if (pathname === '/run') {
      if (Number(request.headers.get('content-length')) > 2048) return new Response(null, { status: 413 })
      let job
      try { job = await request.json() } catch { return new Response(null, { status: 400 }) }
      if (!validJob(job) || job.workload !== workload) return new Response('Invalid issue, workload or Git SHA', { status: 400 })
      reply = await run.begin({ owner, sha: job.sha, workload: job.workload, issue: job.issue })
    } else if (pathname === '/cancel') {
      reply = await run.finish('cancelled')
    } else {
      reply = await run.receipt()
    }
    return Response.json(reply.receipt ?? { message: reply.message }, { status: reply.status })
  },
}

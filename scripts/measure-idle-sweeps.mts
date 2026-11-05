// One-off idle measurement (#1212 D): statements each reconciliation sweep sends to an empty, migrated
// isolated database. Run: node --import ./tests/support/server-only.mjs --import tsx scripts/measure-idle-sweeps.mts
import pg from 'pg'
const target = new URL(process.env.E2E_DATABASE_URL ?? '')
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_e2e')) throw new Error('isolated loopback _e2e database only')
let statements = 0
for (const proto of [pg.Client.prototype, pg.Pool.prototype]) {
  const query = proto.query
  proto.query = function (this: unknown, ...args: unknown[]) {
    if (proto === pg.Client.prototype) {
      statements++
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | null)?.text
      if (process.env.TRACE_SQL) console.error('SQL', String(text).replace(/\s+/g, ' ').slice(0, 100))
    }
    return (query as (...a: unknown[]) => unknown).apply(this, args)
  } as typeof proto.query
}
process.env.CRON_SECRET = 'idle-measure-local-only'
process.env.AI_GATEWAY_API_KEY ??= 'idle-measure-placeholder' // coordinatorEnabled(); nothing is due, so no model call
const request = (path: string) => new Request(`http://localhost/mikka/api/cron/${path}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } })
const routes = { briefings: () => import('../app/api/cron/briefings/route'), 'suggestions-reconcile': () => import('../app/api/cron/suggestions-reconcile/route'), 'user-facts': () => import('../app/api/cron/user-facts/route'), reconcile: () => import('../app/api/cron/reconcile/route'), 'account-deletions': () => import('../app/api/cron/account-deletions/route'), 'audit-retention': () => import('../app/api/cron/audit-retention/route'), 'coordinator-wakes': () => import('../app/api/cron/coordinator-wakes/route'), schedules: () => import('../app/api/cron/schedules/route'), 'run-recovery': () => import('../app/api/cron/run-recovery/route') }
const result: Record<string, number> = {}
for (const [name, load] of Object.entries(routes)) {
  const { GET } = await load()
  await GET(request(name)) // warm-up: module setup queries are not per-call cost
  await new Promise(resolve => setTimeout(resolve, 300))
  const before = statements
  const response = await GET(request(name))
  await new Promise(resolve => setTimeout(resolve, 1500)) // after-response work (group turns)
  result[name] = statements - before
  // Outside a Next request, run-recovery's afterJob (its last line) has no `after` to schedule on and the route
  // answers 502; the group-turn sweep it would schedule is counted directly below.
  // A route missing outside configuration here (a GitHub app, a provider key) answers non-2xx; its count stays, marked.
  if (!response.ok && name !== 'run-recovery') result[`${name}:status`] = response.status
  if (name === 'run-recovery') {
    const { resumePendingGroupTurns } = await import('../lib/group-conversations-route')
    const groups = statements
    await resumePendingGroupTurns(Date.now() + 5_000)
    result['run-recovery'] += statements - groups
  }
}
console.log(JSON.stringify(result))
process.exit(0)

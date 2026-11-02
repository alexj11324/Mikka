import { createHash } from 'node:crypto'
import type { PoolClient, QueryResult } from 'pg'
import { currentRequestRoute } from '@/lib/request-route'
import { deploymentSwitch } from '@/lib/deployment-switches'

// Sampled accounting of what queries send back from the database (Neon bills
// that transfer). A sampled query writes one JSON line: the request's route
// template, the tables and a hash of the SQL text, the row count and the
// result's size as JSON. Never parameters, values or row content. Off unless
// the PostHog gate is on.

/** Share of queries sampled while the PostHog gate `mikka-db-egress-sample` is on (off by default). */
export const SAMPLE_RATE = 0.01

const sampling = () => { try { return deploymentSwitch('dbEgressSample') } catch { return false } }

export type DbSample = { level: 'info'; msg: 'db_sample'; route: string | null; command: string; tables: string[]; statement: string; rows: number; bytes: number }

/** Table names the statement reads or writes; identifiers only. */
function tablesOf(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\b(?:from|join|into|update)\s+(?:only\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) names.add(match[1])
  return [...names].slice(0, 6)
}

export function describeSample(text: string, result: QueryResult | QueryResult[], route: string | null): DbSample {
  const results = Array.isArray(result) ? result : [result]
  const rows = results.reduce((sum, one) => sum + (one.rows?.length ?? 0), 0)
  const bytes = results.reduce((sum, one) => sum + (one.rows?.length ? Buffer.byteLength(JSON.stringify(one.rows)) : 0), 0)
  return {
    level: 'info', msg: 'db_sample', route,
    command: results.at(-1)?.command ?? text.trim().split(/\s+/, 1)[0].toUpperCase(),
    tables: tablesOf(text),
    statement: createHash('sha256').update(text).digest('hex').slice(0, 12),
    rows, bytes,
  }
}

const instrumented = new WeakSet<PoolClient>()

/** Wraps a pooled connection's queries with the sample. `Pool.query` calls it with a callback; checked-out clients use promises. */
export function sampleClient(client: PoolClient, on: () => boolean = sampling, random = Math.random, sink: (line: string) => void = line => console.log(line)) {
  if (instrumented.has(client)) return
  instrumented.add(client)
  const query = client.query.bind(client) as (...args: unknown[]) => unknown
  ;(client as { query: unknown }).query = (...args: unknown[]) => {
    const first = args[0]
    const text = typeof first === 'string' ? first : (first as { text?: unknown } | null)?.text
    if (typeof text !== 'string' || random() >= SAMPLE_RATE || !on()) return query(...args)
    const route = currentRequestRoute() ?? null
    const record = (result: unknown) => {
      try { sink(JSON.stringify(describeSample(text, result as QueryResult, route))) } catch { /* sampling never breaks a query */ }
    }
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      return query(...args.slice(0, -1), (error: unknown, result: unknown) => {
        if (!error) record(result)
        return callback(error, result)
      })
    }
    const pending = query(...args)
    return pending instanceof Promise ? pending.then(result => { record(result); return result }) : pending
  }
}

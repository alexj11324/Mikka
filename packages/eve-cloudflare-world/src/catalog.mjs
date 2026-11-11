import { decodeRecord } from './records.mjs'

const runTable = {
  name: 'world_runs', id: 'run_id', add: ['created_ms INTEGER', 'workflow_name TEXT'],
  update: 'UPDATE world_runs SET created_ms=?,workflow_name=? WHERE run_id=?',
  fields: record => [record.createdAt.getTime(), record.workflowName, record.runId],
}
const hookTable = {
  name: 'world_hooks', id: 'hook_id', add: ['created_ms INTEGER'],
  update: 'UPDATE world_hooks SET created_ms=? WHERE hook_id=?',
  fields: record => [record.createdAt.getTime(), record.hookId],
}

/** All pre-catalog records retain their original timestamp and filter fields.
 * Rolling back to a pre-catalog writer leaves NULL in the indexed columns;
 * the next catalog read repairs those rows from the authoritative CBOR. */
export function initializeCatalog(storage) {
  const sql = storage.sql
  for (const table of [runTable, hookTable]) {
    const columns = new Set(sql.exec('PRAGMA table_info(' + table.name + ')').toArray().map(x => x.name))
    for (const definition of table.add) {
      if (!columns.has(definition.split(' ')[0])) sql.exec('ALTER TABLE ' + table.name + ' ADD COLUMN ' + definition)
    }
    sql.exec(`CREATE INDEX IF NOT EXISTS ${table.name}_created ON ${table.name}(created_ms,${table.id})`)
  }
  sql.exec('CREATE INDEX IF NOT EXISTS world_runs_workflow ON world_runs(workflow_name,status,created_ms,run_id)')
}

function repair(sql, table) {
  for (;;) {
    const missing = sql.exec('SELECT record FROM ' + table.name + ' WHERE created_ms IS NULL LIMIT 100').toArray()
    if (!missing.length) return
    for (const row of missing) sql.exec(table.update, ...table.fields(decodeRecord(row.record)))
  }
}

function page(sql, { table, from, conditions, args, pagination = {}, defaultOrder }) {
  const { limit = 20, sortOrder = defaultOrder, cursor } = pagination
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !['asc', 'desc'].includes(sortOrder)) throw new RangeError('Invalid catalog page')
  const ascending = sortOrder === 'asc'
  if (cursor != null) {
    const pair = JSON.parse(cursor)
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[0]) || typeof pair[1] !== 'string') throw new RangeError('Invalid catalog cursor')
    conditions.push(`(t.created_ms,t.${table.id})${ascending ? '>' : '<'}(?,?)`)
    args.push(...pair)
  }
  const direction = ascending ? 'ASC' : 'DESC'
  repair(sql, table)
  const rows = sql.exec(`SELECT t.record,t.created_ms,t.${table.id} AS id FROM ${from}
    WHERE ${conditions.length ? conditions.join(' AND ') : '1=1'} ORDER BY t.created_ms ${direction},t.${table.id} ${direction} LIMIT ?`,
    ...args, limit + 1).toArray()
  const selected = rows.slice(0, limit)
  const hasMore = rows.length > limit
  return { data: selected.map(row => decodeRecord(row.record)), hasMore,
    cursor: hasMore ? JSON.stringify([selected.at(-1).created_ms, selected.at(-1).id]) : null }
}

export function listRuns(storage, { workflowName, status, pagination } = {}) {
  const conditions = [], args = []
  if (workflowName !== undefined) { conditions.push('t.workflow_name=?'); args.push(workflowName) }
  if (status !== undefined) {
    const statuses = Array.isArray(status) ? [...new Set(status)] : [status]
    if (!statuses.length) return { data: [], hasMore: false, cursor: null }
    conditions.push('t.status IN (' + statuses.map(() => '?').join(',') + ')')
    args.push(...statuses)
  }
  return page(storage.sql, { table: runTable, from: 'world_runs t', conditions, args, pagination, defaultOrder: 'desc' })
}

export function listHooks(storage, { runId, pagination } = {}, now = Date.now()) {
  const conditions = ["(r.status NOT IN ('completed','failed','cancelled') OR t.retain_until>?)"], args = [now]
  if (runId !== undefined) { conditions.push('t.run_id=?'); args.push(runId) }
  return page(storage.sql, { table: hookTable, from: 'world_hooks t JOIN world_runs r ON r.run_id=t.run_id',
    conditions, args, pagination, defaultOrder: 'asc' })
}

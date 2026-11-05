import { MapReadError } from './read-contracts'

const columns = {
  issues: ['id', 'title', 'status', 'createdAt', 'blockedByIds'],
  runs: ['id', 'issueId', 'status', 'outcome', 'createdAt', 'finishedAt', 'retryOf', 'continuesRunId', 'threadReplacedBy', 'harness', 'modelId', 'owned'],
} as const
type Kind = keyof typeof columns

/** Constant columns contain one value; every other column has exactly count
 * values. SQL NULL, JSON arrays and an empty table are therefore unambiguous.
 * The columns object is jsonb, preserving the old row objects' key order. */
export function compactMapRowsSql(name: string, kind: Kind) {
  const order = kind === 'issues' ? 'id' : '"createdAt",id'
  const encoded = columns[kind].map(column => {
    const value = column === 'createdAt' || column === 'finishedAt'
      // Date's ISO parser truncates fractional milliseconds, including dates
      // before 1970. Casting the numeric epoch to bigint would round instead.
      ? `floor(extract(epoch FROM "${column}") * 1000)`
      : kind === 'runs' && column === 'issueId' ? '(array_position($1::uuid[],"issueId")-1)' : `"${column}"`
    const values = `jsonb_agg(${value} ORDER BY ${order})`
    return `'${column}',CASE WHEN count(*)=0 THEN '[]'::jsonb
      WHEN count(DISTINCT COALESCE(to_jsonb(${value}),'null'::jsonb))=1 THEN jsonb_build_array(${values}->0)
      ELSE ${values} END`
  })
  return `(SELECT jsonb_build_object('count',count(*),'columns',jsonb_build_object(${encoded.join(',')})) FROM ${name})`
}

export function decodeMapRows<T>(raw: unknown, kind: Kind, issueIds: readonly string[], max: number): T[] {
  const invalid = () => new MapReadError('map_unavailable', { detail: 'database' })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid()
  const { count, columns: values } = raw as { count: unknown; columns: unknown }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > max
    || !values || typeof values !== 'object' || Array.isArray(values)) throw invalid()
  const entries = Object.entries(values)
  if (entries.length !== columns[kind].length || columns[kind].some(column => !Object.hasOwn(values, column))) throw invalid()
  for (const [, value] of entries)
    if (!Array.isArray(value) || (count === 0 ? value.length !== 0 : value.length !== 1 && value.length !== count)) throw invalid()
  return Array.from({ length: count }, (_, index) => Object.fromEntries(entries.map(([column, vector]) => {
    let value = vector[(vector as unknown[]).length === 1 ? 0 : index]
    if (column === 'createdAt' || column === 'finishedAt') {
      if (value === null && column === 'finishedAt') return [column, null]
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > 8.64e15) throw invalid()
      value = new Date(value).toISOString()
    } else if (kind === 'runs' && column === 'issueId') {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= issueIds.length) throw invalid()
      const id = issueIds[value]
      if (typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw invalid()
      value = id.toLowerCase()
    }
    return [column, value]
  })) as T)
}

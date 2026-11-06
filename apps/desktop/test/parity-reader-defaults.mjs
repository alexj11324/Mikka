import { TestAccountError } from '../../../scripts/test-accounts/pool.mjs'

const tables = ['attention_settings', 'user_time_zones', 'briefings']
const fields = {
  attention_settings: ['userId', 'enabled', 'locale', 'updatedAt'],
  user_time_zones: ['userId', 'timeZone', 'source', 'detectedTimeZone', 'updatedAt'],
  briefings: ['userId', 'localDate', 'kind', 'timeZone', 'highlights', 'counts', 'total', 'createdAt'],
}
const fail = code => { throw new TestAccountError(code) }
const sameKeys = (row, expected) => Object.keys(row).sort().join('|') === [...expected].sort().join('|')

/** Suggestions remembers the actual reader's locale/time zone and lazily
 * writes an empty daily briefing. Capture inside the current-lease fixture
 * transaction before UI starts; never adopt or restore pre-existing rows. */
export async function captureParityReaderDefaults(client, ownerId) {
  const read = async tx => {
    const result = new Map()
    for (const table of tables) {
      const rows = (await tx.query(`SELECT to_jsonb(t) AS value FROM public."${table}" t WHERE t."userId"=$1 FOR UPDATE`, [ownerId])).rows
      result.set(table, rows.map(row => row.value))
    }
    return result
  }
  const capturedAt = new Date((await client.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime()
  if (!Number.isFinite(capturedAt)) fail('PARITY_DEFAULT_CLOCK_UNPROVEN')
  const baseline = await read(client)
  if ([...baseline.values()].some(rows => rows.length)) fail('PARITY_DEFAULT_BASELINE_PRESENT')
  return async tx => {
    const rows = await read(tx)
    const until = new Date((await tx.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime()
    if (!Number.isFinite(until) || until < capturedAt) fail('PARITY_DEFAULT_CLOCK_UNPROVEN')
    const during = value => { const at = Date.parse(value); return Number.isFinite(at) && at >= capturedAt && at <= until }
    // Validate every row before the first deletion. Non-default settings,
    // real suggestions, older rows and another user's records stay dirty.
    for (const [table, values] of rows) {
      if (values.length > (table === 'briefings' ? 2 : 1)) fail('PARITY_DEFAULT_OWNERSHIP_UNPROVEN')
      for (const row of values) {
        if (row.userId !== ownerId || !sameKeys(row, fields[table])) fail('PARITY_DEFAULT_OWNERSHIP_UNPROVEN')
        if (table === 'attention_settings' && !(row.enabled === true && row.locale === 'en' && during(row.updatedAt))) fail('PARITY_DEFAULT_OWNERSHIP_UNPROVEN')
        if (table === 'user_time_zones' && !(row.source === 'auto' && row.timeZone === 'UTC' && row.detectedTimeZone === 'UTC' && during(row.updatedAt))) fail('PARITY_DEFAULT_OWNERSHIP_UNPROVEN')
        if (table === 'briefings' && !(row.kind === 'daily' && row.timeZone === 'UTC' && row.total === 0
          && Array.isArray(row.highlights) && row.highlights.length === 0
          && row.counts && typeof row.counts === 'object' && !Array.isArray(row.counts) && Object.keys(row.counts).length === 0
          && during(row.createdAt) && row.localDate === new Date(row.createdAt).toISOString().slice(0, 10))) fail('PARITY_DEFAULT_OWNERSHIP_UNPROVEN')
      }
    }
    for (const [table, values] of rows) for (const row of values) {
      const result = await tx.query(`DELETE FROM public."${table}" t WHERE t."userId"=$1 AND to_jsonb(t)=$2::jsonb`, [ownerId, JSON.stringify(row)])
      if (result.rowCount !== 1) fail('PARITY_DEFAULT_CHANGED')
    }
  }
}

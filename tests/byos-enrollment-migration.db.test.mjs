import assert from 'node:assert/strict'
import {test} from 'node:test'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {Pool} from 'pg'
test('source cleanup migration backfills legacy published transfers and replays without erasing history', async () => {
  const databaseUrl = process.env.MIKKA_BYOS_TEST_DATABASE_URL
  assert.ok(databaseUrl && new URL(databaseUrl).hostname === '127.0.0.1' && new URL(databaseUrl).pathname.endsWith('_e2e'))
  const pool = new Pool({connectionString:databaseUrl,max:1})
  const client = await pool.connect(), schema = `escrow_migration_${randomUUID().replaceAll('-','')}`
  try {
    await client.query(`create schema ${schema}`);await client.query(`set search_path to ${schema}`)
    await client.query('create table byos_connections(id uuid primary key); create table byos_enrollment_transfers("enrollmentId" uuid primary key,"connectionId" uuid references byos_connections(id),"boundAt" timestamptz)')
    const connected=randomUUID(), pending=randomUUID()
    await client.query('insert into byos_connections values($1),($2)',[connected,pending])
    await client.query('insert into byos_enrollment_transfers values($1,$2,now()),($3,$4,null)',[randomUUID(),connected,randomUUID(),pending])
    const sql = await readFile(new URL('../drizzle/20261025141656_byos_enrollment_cleanup.sql',import.meta.url),'utf8')
    await client.query(sql);await client.query(sql)
    const {rows} = await client.query('select t."connectionId",t."boundAt",t."canonicalPublishedAt",t."sourceCreationState",count(s.*)::int copies from byos_enrollment_transfers t join byos_enrollment_sources s using("enrollmentId") group by t."enrollmentId"')
    assert.equal(rows.length,2)
    for(const row of rows){assert.equal(row.copies,2);assert.equal(row.sourceCreationState,'unknown');assert.equal(row.canonicalPublishedAt?.toISOString(),row.boundAt?.toISOString())}
  } finally {console.log(JSON.stringify({fixture:'byos-enrollment-migration',schema,disposition:'retained'}));client.release(true);await pool.end()}
})

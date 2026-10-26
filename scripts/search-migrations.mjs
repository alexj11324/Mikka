// Compatibility for the four frozen search migrations only. Never alter SQL bytes.
import { readFileSync } from 'node:fs'
import { fullHash } from './historical-migrations.mjs'
const manifestURL = new URL('../drizzle/search-supersessions.json', import.meta.url)
export const SEARCH_MANIFEST_SHA256 = 'da2b0b6c21226a164681aacfd21a2d93343e5dc673746ac3bf358d8877f9ef7f'
export function searchSupersessions(files, bytes = readFileSync(manifestURL), read = path => readFileSync(new URL('../' + path, import.meta.url))) {
  if (fullHash(bytes) !== SEARCH_MANIFEST_SHA256) throw Error('Search supersession manifest digest mismatch')
  const manifest = JSON.parse(bytes)
  if (manifest.version !== 1 || manifest.entries.length !== 4) throw Error('Invalid search supersessions')
  for (const e of manifest.entries) {
    const matches = files.filter(f => f.name === e.canonicalName)
    if (matches.length !== 1 || fullHash(matches[0].content) !== e.canonicalSha256 || fullHash(read(e.archivePath)) !== e.legacySha256 || files.some(f => f.name === e.legacyName)) throw Error('Search migration identity/content mismatch: ' + e.canonicalName)
  }
  return manifest.entries
}
const entries = () => searchSupersessions(JSON.parse(readFileSync(manifestURL)).entries.map(e => ({name:e.canonicalName,content:readFileSync(new URL('../drizzle/'+e.canonicalName,import.meta.url))})))
const quote = name => '"' + name.replaceAll('"','""') + '"'
async function extension(client) {
  const { rows } = await client.query("SELECT e.oid,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'")
  if (rows.length !== 1) throw Error('Search migration requires pg_trgm')
  return rows[0]
}
/** The caller supplies a dedicated checked-out client, never a business pool. */
export async function executeMigration(client, name, sql) {
  const entry = entries().find(e => e.canonicalName === name)
  if (entry && fullHash(sql) !== entry.canonicalSha256) throw Error('Frozen search SQL mismatch')
  if (name !== '20261026013001_issue_search_title_idx.sql') return client.query(sql)
  const ext = await extension(client)
  const before = (await client.query("SELECT current_setting('search_path') AS path, to_regclass('issues')::oid AS oid")).rows[0]
  if (!before.oid) throw Error('Search target issues missing')
  let result, failure
  try {
    await client.query("SELECT set_config('search_path',$1,false)", [before.path + ', ' + quote(ext.nspname)])
    const now = (await client.query("SELECT to_regclass('issues')::oid AS oid")).rows[0]
    if (now.oid !== before.oid) throw Error('Search target changed')
    result = await client.query(sql)
  } catch (error) { failure = error }
  try { await client.query("SELECT set_config('search_path',$1,false)", [before.path]) }
  catch (error) { client.release?.(true); throw new AggregateError([failure,error].filter(Boolean),'Migration path restoration failed') }
  if (failure) throw failure
  return result
}
/** Fixture convenience: bind adjustments to one connection, restored before release. */
export async function executePoolMigration(pool, name, sql) {
  const client = await pool.connect()
  let destroyed = false
  const scoped = {query:client.query.bind(client),release:()=>{destroyed=true;client.release(true)}}
  try { return await executeMigration(scoped,name,sql) } finally { if(!destroyed)client.release() }
}

const definitions = [null,
  {name:'issues_title_search_trgm_idx',method:'gin',keys:['title'],columns:['title'],options:[0],opclasses:['gin_trgm_ops']},
  {name:'issues_owner_updated_id_idx',method:'btree',keys:['"userId"','"updatedAt"','id'],columns:['userId','updatedAt','id'],options:[0,3,3],opclasses:['text_ops','timestamptz_ops','uuid_ops']},
  {name:'issues_owner_number_search_idx',method:'btree',keys:['"userId"',"((COALESCE(((content -> 'attrs'::text) -> 'mikka'::text), ((content -> 'attrs'::text) -> 'orvilo'::text)) ->> 'number'::text))"],columns:['userId',null],options:[0,0],opclasses:['text_ops','text_ops']},
]
export async function validateSearchObject(client, entry) {
  const all = entries(), position = all.findIndex(e => e.canonicalName === entry.canonicalName)
  if (position < 0) throw Error('Unknown search migration')
  const ext = await extension(client)
  if (position === 0) return
  const expected = definitions[position]
  const {rows} = await client.query(`SELECT i.indisvalid,i.indisready,i.indisunique,i.indnkeyatts,i.indnatts,
    i.indpred IS NULL AS unfiltered,am.amname,
    ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,false) FROM generate_series(1,i.indnkeyatts) k) AS keys,
    i.indoption::smallint[] AS options, i.indclass::oid[] AS classes, i.indcollation::oid[] AS collations,
    ARRAY(SELECT o.oid FROM unnest($3::text[]) WITH ORDINALITY names(name,n) JOIN pg_opclass o ON o.opcname=names.name AND o.opcmethod=idx.relam JOIN pg_namespace ns ON ns.oid=o.opcnamespace WHERE ns.nspname=$5 ORDER BY names.n) AS expected_classes,
    ARRAY(SELECT CASE WHEN cols.name IS NULL THEN (SELECT oid FROM pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace) ELSE (SELECT attcollation FROM pg_attribute WHERE attrelid=tbl.oid AND attname=cols.name AND NOT attisdropped) END FROM unnest($4::text[]) WITH ORDINALITY cols(name,n) ORDER BY cols.n) AS expected_collations,
    ARRAY(SELECT n.nspname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY c(oid,n) JOIN pg_opclass o ON o.oid=c.oid JOIN pg_namespace n ON n.oid=o.opcnamespace ORDER BY c.n) AS namespaces,
    ARRAY(SELECT o.opcname::text FROM unnest(i.indclass::oid[]) WITH ORDINALITY c(oid,n) JOIN pg_opclass o ON o.oid=c.oid ORDER BY c.n) AS opclasses,
    EXISTS(SELECT 1 FROM unnest(i.indclass::oid[]) c(oid) JOIN pg_depend d ON d.classid='pg_opclass'::regclass AND d.objid=c.oid AND d.refclassid='pg_extension'::regclass AND d.refobjid=$2 AND d.deptype='e') AS extension_owned
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class tbl ON tbl.oid=i.indrelid JOIN pg_am am ON am.oid=idx.relam
    WHERE i.indrelid=to_regclass('issues') AND idx.relnamespace=tbl.relnamespace AND idx.relname=$1`,[expected.name,ext.oid,expected.opclasses,expected.columns,position===1?ext.nspname:'pg_catalog'])
  const r=rows[0]
  if(rows.length!==1 || !r.indisvalid || !r.indisready || r.indisunique || !r.unfiltered || r.amname!==expected.method || r.indnatts!==expected.keys.length || r.indnkeyatts!==expected.keys.length || JSON.stringify(r.keys)!==JSON.stringify(expected.keys) || JSON.stringify(r.options)!==JSON.stringify(expected.options) || JSON.stringify(r.opclasses)!==JSON.stringify(expected.opclasses) || JSON.stringify(r.classes)!==JSON.stringify(r.expected_classes) || JSON.stringify(r.collations)!==JSON.stringify(r.expected_collations) || (position===1&&!r.extension_owned) || (position>1&&r.namespaces.some(n=>n!=='pg_catalog'))) throw Error('Search migration object mismatch: '+entry.canonicalName)
}
/** Called under the migration session advisory lock; no renamed SQL is executed. */
export async function aliasSearchMigration(client, entry) {
  await client.query('BEGIN')
  try {
    await client.query('LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE')
    await client.query('LOCK TABLE issues IN SHARE MODE')
    await validateSearchObject(client,entry)
    await client.query('INSERT INTO schema_migrations(name) SELECT $1 WHERE EXISTS(SELECT 1 FROM schema_migrations WHERE name=$2) ON CONFLICT(name) DO NOTHING',[entry.canonicalName,entry.legacyName])
    await client.query('COMMIT')
  } catch(error) { await client.query('ROLLBACK'); throw error }
}

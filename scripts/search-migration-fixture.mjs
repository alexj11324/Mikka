// Retained synthetic schemas; called by the dual-DB historical acceptance.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { executeMigration, aliasSearchMigration, validateSearchObject, searchSupersessions } from './search-migrations.mjs'
export async function verifySearchCompatibility(pool) {
  const entries=JSON.parse(readFileSync(new URL('../drizzle/search-supersessions.json',import.meta.url))).entries
  const files=entries.map(e=>({name:e.canonicalName,content:readFileSync(new URL('../drizzle/'+e.canonicalName,import.meta.url))}))
  searchSupersessions(files)
  assert.throws(()=>searchSupersessions(files.map((f,i)=>i===0?{...f,content:Buffer.from('changed')}:f)),/mismatch/)
  assert.throws(()=>searchSupersessions(files,undefined,()=>{throw Error('archive absent')}),/archive absent/)
  const client=await pool.connect(),schemas=[]
  try {
    for(const count of [4,2,1]) {
      const schema='search_legacy_'+randomUUID().replaceAll('-','');schemas.push(schema)
      await client.query(`CREATE SCHEMA "${schema}"`)
      await client.query(`SET search_path TO "${schema}"`)
      await client.query('CREATE TABLE issues(id uuid PRIMARY KEY,"userId" text,title text,"updatedAt" timestamptz,content jsonb)')
      await client.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
      for(const e of entries.slice(0,count)) {
        await client.query(readFileSync(new URL('../'+e.archivePath,import.meta.url),'utf8'))
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[e.legacyName])
      }
      const before=(await client.query('SELECT name,"appliedAt"::text AS at FROM schema_migrations ORDER BY name')).rows
      const indexBefore=(await client.query("SELECT indexrelid FROM pg_index WHERE indrelid='issues'::regclass ORDER BY indexrelid")).rows
      for(const [i,e] of entries.entries()) {
        if(i<count) await aliasSearchMigration(client,e)
        else {
          await executeMigration(client,e.canonicalName,files[i].content.toString())
          await validateSearchObject(client,e)
          await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[e.canonicalName])
        }
      }
      const after=(await client.query('SELECT name,"appliedAt"::text AS at FROM schema_migrations ORDER BY name')).rows
      for(const row of before)assert.deepEqual(after.find(r=>r.name===row.name),row)
      assert.deepEqual(after.map(r=>r.name),[...entries.map(e=>e.canonicalName),...entries.slice(0,count).map(e=>e.legacyName)].sort())
      const indexAfter=(await client.query("SELECT indexrelid FROM pg_index WHERE indrelid='issues'::regclass ORDER BY indexrelid")).rows
      for(const row of indexBefore)assert.ok(indexAfter.some(r=>r.indexrelid===row.indexrelid),'alias must preserve object OID')
      for(const e of entries.slice(0,count))await aliasSearchMigration(client,e)
      assert.deepEqual((await client.query('SELECT name,"appliedAt"::text AS at FROM schema_migrations ORDER BY name')).rows,after)
      assert.equal((await client.query('SHOW search_path')).rows[0].search_path,schema)
    }
    const schema='search_wrong_'+randomUUID().replaceAll('-','');schemas.push(schema)
    await client.query(`CREATE SCHEMA "${schema}"`);await client.query(`SET search_path TO "${schema}"`)
    await client.query('CREATE TABLE issues(id uuid PRIMARY KEY,title text)')
    await client.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[entries[1].legacyName])
    await client.query('CREATE INDEX issues_title_search_trgm_idx ON issues(title)')
    await assert.rejects(aliasSearchMigration(client,entries[1]),/object mismatch/)
    assert.deepEqual((await client.query('SELECT name FROM schema_migrations')).rows,[{name:entries[1].legacyName}])
    // A SQL error cannot leave the extension namespace on this connection.
    await client.query('ALTER TABLE issues RENAME COLUMN title TO other')
    await client.query('ALTER INDEX issues_title_search_trgm_idx RENAME TO retained_wrong_index')
    await assert.rejects(executeMigration(client,entries[1].canonicalName,files[1].content.toString()),/title/)
    assert.equal((await client.query('SHOW search_path')).rows[0].search_path,schema)
    // Use a new retained schema to exercise concurrent alias and an actual lost connection.
    const race='search_race_'+randomUUID().replaceAll('-','');schemas.push(race)
    await client.query(`CREATE SCHEMA "${race}"`);await client.query(`SET search_path TO "${race}"`)
    await client.query('CREATE TABLE issues(id uuid PRIMARY KEY,title text)')
    await client.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    await client.query(readFileSync(new URL('../'+entries[1].archivePath,import.meta.url),'utf8'))
    await client.query('INSERT INTO schema_migrations(name) VALUES($1)',[entries[1].legacyName])
    const broken=await pool.connect()
    broken.on('error',()=>{})
    try {
      await broken.query(`SET search_path TO "${race}"`)
      const pid=(await broken.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await assert.rejects(aliasSearchMigration({query:async(sql,args)=>{
        if(sql==='COMMIT')await client.query('SELECT pg_terminate_backend($1)',[pid])
        return broken.query(sql,args)
      }},entries[1]))
    } finally {broken.release(true)}
    assert.deepEqual((await client.query('SELECT name FROM schema_migrations')).rows,[{name:entries[1].legacyName}])
    const peers=await Promise.all([pool.connect(),pool.connect()])
    try {
      await Promise.all(peers.map(async peer=>{await peer.query(`SET search_path TO "${race}"`);await aliasSearchMigration(peer,entries[1])}))
    } finally {peers.forEach(peer=>peer.release(true))}
    assert.deepEqual((await client.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r=>r.name),[entries[1].legacyName,entries[1].canonicalName].sort())
    const extSchema='search_extension_'+randomUUID().replaceAll('-','');schemas.push(extSchema)
    await client.query(`CREATE SCHEMA "${extSchema}"`)
    await client.query(`ALTER EXTENSION pg_trgm SET SCHEMA "${extSchema}"`)
    const isolated='search_isolated_'+randomUUID().replaceAll('-','');schemas.push(isolated)
    await client.query(`CREATE SCHEMA "${isolated}"`);await client.query(`SET search_path TO "${isolated}"`)
    await client.query('CREATE TABLE issues(id uuid PRIMARY KEY,title text)')
    await assert.rejects(validateSearchObject(client,entries[1]),/object mismatch/,'other schema index cannot satisfy this schema')
    const businessPath=(await pool.query('SHOW search_path')).rows[0].search_path
    await executeMigration(client,entries[1].canonicalName,files[1].content.toString())
    await validateSearchObject(client,entries[1])
    assert.equal((await client.query('SHOW search_path')).rows[0].search_path,isolated)
    assert.equal((await pool.query('SHOW search_path')).rows[0].search_path,businessPath)
    const failedRestore=await pool.connect();let sets=0,destroyed=false
    await failedRestore.query(`SET search_path TO "${isolated}"`)
    await assert.rejects(executeMigration({query:async(sql,args)=>{
      if(sql.includes("set_config('search_path'")&&++sets===2)throw Error('controlled restoration failure')
      return failedRestore.query(sql,args)
    },release:()=>{destroyed=true;failedRestore.release(true)}},entries[1].canonicalName,files[1].content.toString()),/restoration failed/)
    assert.equal(destroyed,true)
    // A cancelled concurrent build leaves a real INVALID index; retain it as evidence.
    const invalid='search_invalid_'+randomUUID().replaceAll('-','');schemas.push(invalid)
    await client.query(`CREATE SCHEMA "${invalid}"`);await client.query(`SET search_path TO "${invalid}"`)
    await client.query('CREATE TABLE issues(id uuid PRIMARY KEY,title text)')
    const blocker=await pool.connect()
    try {
      await blocker.query('BEGIN');await blocker.query(`INSERT INTO "${invalid}".issues(id,title) VALUES($1,'retained invalid-index fixture')`,[randomUUID()])
      await client.query("SET statement_timeout TO '150ms'")
      await assert.rejects(executeMigration(client,entries[1].canonicalName,files[1].content.toString()),/statement timeout/)
      await blocker.query('COMMIT')
    } finally {blocker.release(true);await client.query("SET statement_timeout TO '60s'")}
    const invalidState=(await client.query("SELECT indisvalid FROM pg_index WHERE indexrelid='issues_title_search_trgm_idx'::regclass")).rows
    assert.deepEqual(invalidState,[{indisvalid:false}])
    await assert.rejects(validateSearchObject(client,entries[1]),/object mismatch/)
    for(const variant of ['opclass','collation']) {
      const mismatch='search_'+variant+'_'+randomUUID().replaceAll('-','');schemas.push(mismatch)
      await client.query(`CREATE SCHEMA "${mismatch}"`);await client.query(`SET search_path TO "${mismatch}"`)
      await client.query('CREATE TABLE issues(id uuid PRIMARY KEY,"userId" text,"updatedAt" timestamptz)')
      const modifier=variant==='opclass'?'text_pattern_ops':'COLLATE "C"'
      await client.query(`CREATE INDEX issues_owner_updated_id_idx ON issues ("userId" ${modifier},"updatedAt" DESC,id DESC)`)
      await assert.rejects(validateSearchObject(client,entries[2]),/object mismatch/)
    }
    return {schemas,completeAndPartialLegacy:[4,2,1],oldLedgerAndObjectOidsRetained:true,replayNoop:true,wrongObjectRejected:true,pathRestoredAfterFailure:true,lostConnectionAliasRolledBack:true,concurrentAliasExactlyOnce:true,extensionNamespaceIsolated:true,invalidIndexRejected:true,wrongOpclassAndCollationRejected:true,restorationFailureDestroysConnection:true}
  } finally { client.release(true) }
}

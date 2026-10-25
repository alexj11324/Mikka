import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
// A production build with explicit opt-out must exit before attempting even
// ledger DDL. Deliberately invalid URLs make any connection attempt fail.
test('explicit production migration opt-out never connects to a database',()=>{
 const result=spawnSync(process.execPath,['scripts/migrate.mjs'],{
  cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:10000,
  env:{PATH:process.env.PATH,VERCEL_ENV:'production',MIGRATE:'0',MIKKA_DATABASE_URL:'invalid-fixture',DATABASE_URL:'invalid-fixture'},
 })
 assert.equal(result.status,0,result.stderr)
 assert.match(result.stdout,/explicit MIGRATE=0/)
 assert.equal(result.stderr,'')
})

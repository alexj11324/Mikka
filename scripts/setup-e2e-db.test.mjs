import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import test from 'node:test'

test('disposable setup rejects pg routing overrides before opening a connection',()=>{
 for(const suffix of ['?host=remote.example.invalid','?hostaddr=192.0.2.1','?service=external','#fragment']){
  const result=spawnSync(process.execPath,['--import','tsx','scripts/setup-e2e-db.mjs'],{
   env:{...process.env,E2E_DATABASE_URL:'postgres://fixture:fixture@127.0.0.1/disposable_e2e'+suffix},encoding:'utf8',timeout:10000,
  })
  assert.equal(result.status,1)
  assert.match(result.stderr,/无查询参数或片段/)
 }
})

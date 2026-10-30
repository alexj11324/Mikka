import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { budgetedCiFetch, checkCiBudget, CiBudgetDeferred } from '../lib/github/ci/budget'

test('shared budget fences concurrent workers and recovers after rate-limit cooldown',async()=>{
  const url=process.env.CI_NATIVE_RETAINED_DATABASE_URL
  if(!url||new URL(url).hostname!=='127.0.0.1'||new URL(url).pathname!=='/mikka_ci_native')throw Error('isolated retained fixture required')
  const admin=new Pool({connectionString:url});const schema=`ci_budget_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`)
  const db=new Pool({connectionString:scoped.toString(),max:20})
  await db.query('CREATE TABLE github_ci_api_budget (id boolean primary key, "windowStart" timestamptz not null,used integer not null,"blockedUntil" timestamptz)')
  await db.query(`INSERT INTO github_ci_api_budget VALUES (true,now(),590,NULL)`)
  let calls=0
  const limited=budgetedCiFetch(db,async()=>{calls++;return new Response(null,{status:200})})
  const results=await Promise.allSettled(Array.from({length:20},()=>limited('https://example.invalid')))
  assert.equal(results.filter(r=>r.status==='fulfilled').length,10);assert.equal(calls,10)
  assert.equal((await db.query('SELECT used FROM github_ci_api_budget')).rows[0].used,600)
  await assert.rejects(checkCiBudget(db),CiBudgetDeferred)
  await db.query(`UPDATE github_ci_api_budget SET "windowStart"=now()-interval '2 hours'`)
  const throttled=budgetedCiFetch(db,async()=>new Response(null,{status:429,headers:{'retry-after':'60'}}))
  await assert.rejects(throttled('https://example.invalid'),CiBudgetDeferred)
  await assert.rejects(limited('https://example.invalid'),CiBudgetDeferred)
  await db.query(`UPDATE github_ci_api_budget SET "blockedUntil"=now()-interval '1 second'`)
  await checkCiBudget(db)
  assert.equal((await limited('https://example.invalid')).status,200)
  console.log(`Retained CI budget schema: ${schema}`);await db.end();await admin.end()
})

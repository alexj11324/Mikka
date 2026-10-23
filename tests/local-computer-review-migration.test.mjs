import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
test('local review ledger migration is idempotent and decision cannot be replayed or reassigned', async () => {
  assert.equal(process.env.CI, 'true');
  const url = new URL(process.env.E2E_DATABASE_URL);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname) && url.pathname === '/mikka_e2e');
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const db = await pool.connect();
  try {
    await db.query('begin');
    const schema = 'local_review_' + randomUUID().replaceAll('-', '');
    await db.query(`create schema "${schema}"`);
    await db.query(`set local search_path to "${schema}"`);
    await db.query('create table devices (id uuid primary key); create table agent_runs (id uuid primary key)');
    const sql = await readFile(new URL('../drizzle/20261023185542_local_computer_reviews.sql', import.meta.url), 'utf8');
    await db.query(sql); await db.query(sql);
    const [id, device, run] = [randomUUID(),randomUUID(),randomUUID()];
    await db.query('insert into devices values ($1)', [device]);
    await db.query('insert into agent_runs values ($1)', [run]);
    await db.query(`insert into local_computer_reviews (id,"deviceId","runId","userId",target,call,digest,"expiresAt","seenAt") values ($1,$2,$3,'owner','target','{}','digest',now()+interval '5 minutes',now())`, [id,device,run]);
    const decide = (user, digest) => db.query(`update local_computer_reviews set decision=true where id=$1 and "userId"=$2 and digest=$3 and decision is null and "expiresAt">now() returning id`, [id,user,digest]);
    assert.equal((await decide('other','digest')).rowCount, 0);
    assert.equal((await decide('owner','changed')).rowCount, 0);
    assert.equal((await decide('owner','digest')).rowCount, 1);
    assert.equal((await decide('owner','digest')).rowCount, 0);
    await db.query('delete from devices where id=$1', [device]);
    assert.equal((await db.query('select * from local_computer_reviews')).rowCount, 0);
  } finally { await db.query('rollback'); db.release(); await pool.end() }
});

import { createServer } from 'node:http'
import { Pool } from 'pg'
import { CoordinatorInbox, isolatedInboxOptions, controlledEffect } from '../../lib/coordinator/wake-test-helpers'
import type { WakeDelivery } from '../../lib/coordinator/inbox-receipts'
async function main() {
  const url = process.env.WAKE_TEST_DATABASE_URL,
    token = process.env.WAKE_CONTROL_TOKEN,
    port = Number(process.env.WAKE_CONTROL_PORT ?? 6176)
  if (
    !url ||
    new URL(url).hostname !== '127.0.0.1' ||
    !new URL(url).pathname.endsWith('_176') ||
    !token ||
    process.env.DECISION_GATEWAY_API_KEY ||
    process.env.AI_GATEWAY_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENCODE_API_KEY ||
    process.env.VERCEL
  )
    throw new Error('isolated controlled transport only')
  const pool = new Pool({ connectionString: url, max: 10 }),
    members = new Pool({ connectionString: url, max: 10 })
  const inbox = new CoordinatorInbox(
    pool,
    isolatedInboxOptions(pool, members, () => new Date()),
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS wake_control_jobs(token uuid PRIMARY KEY,owner_id text NOT NULL,event_id uuid NOT NULL,state text NOT NULL DEFAULT 'queued',holder text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`,
  )
  await pool.query(
    `CREATE TABLE IF NOT EXISTS wake_control_settings(id integer PRIMARY KEY,failures integer NOT NULL DEFAULT 0,drop_start_ack boolean NOT NULL DEFAULT false,phase text NOT NULL DEFAULT 'normal')`,
  )
  await pool.query('INSERT INTO wake_control_settings(id) VALUES(1) ON CONFLICT DO NOTHING')
  await pool.query(
    'CREATE TABLE IF NOT EXISTS wake_control_effects(operation_id uuid PRIMARY KEY,executions integer NOT NULL)',
  )
  // Lose in-flight transport runs on OS restart. Only the formal shared inbox
  // sweep may replace their delivery; this fixture never recovers one itself.
  await pool.query("UPDATE wake_control_jobs SET state='abandoned' WHERE state='started'")
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end()
      return
    }
    if (req.url !== '/start' || req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    try {
      let text = ''
      for await (const data of req) {
        text += String(data)
        if (text.length > 2000) throw new Error('large control input')
      }
      const input = JSON.parse(text) as { owner: string; delivery: WakeDelivery }
      const settings = (await pool.query('SELECT * FROM wake_control_settings WHERE id=1')).rows[0]
      if (settings.failures > 0) {
        await pool.query('UPDATE wake_control_settings SET failures=failures-1 WHERE id=1')
        res.writeHead(503).end()
        return
      }
      const holder = `controlled-${input.delivery.token}`
      await pool.query(
        'INSERT INTO wake_control_jobs(token,owner_id,event_id,holder) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [input.delivery.token, input.owner, input.delivery.eventId, holder],
      )
      if (settings.drop_start_ack) {
        await pool.query('UPDATE wake_control_settings SET drop_start_ack=false WHERE id=1')
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ runId: holder }))
    } catch {
      res.writeHead(500).end()
    }
  })
  server.listen(port, '127.0.0.1', () =>
    process.stdout.write(
      JSON.stringify({ phase: 'controlled transport ready', port, realWorkflow: false, realModel: false }) + '\n',
    ),
  )
  let busy = false
  setInterval(() => {
    if (busy) return
    busy = true
    consume().finally(() => {
      busy = false
    })
  }, 30)
  async function consume() {
    const job = (
      await pool.query(
        `WITH j AS(SELECT token FROM wake_control_jobs WHERE state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE wake_control_jobs w SET state='started' FROM j WHERE w.token=j.token RETURNING w.*`,
      )
    ).rows[0]
    if (!job) return
    const delivery = { eventId: job.event_id, token: job.token }
    try {
      const receipt = await inbox.take(job.owner_id, job.holder, delivery)
      if (!receipt.held) {
        await done()
        return
      }
      const settings = (await pool.query('SELECT * FROM wake_control_settings WHERE id=1')).rows[0]
      process.stdout.write(
        JSON.stringify({ phase: 'staged', eventId: job.event_id, recovery: receipt.recovery }) + '\n',
      )
      if (settings.phase === 'hold_staged') {
        await new Promise(() => {})
        return
      }
      let checkpoint = await inbox.cached(job.owner_id, delivery)
      if (!checkpoint) {
        if (receipt.notifyOnly) {
          await inbox.acknowledge(job.owner_id, job.holder, delivery, [
            { role: 'assistant', content: 'Controlled stopped notification; no task resumed.' },
          ])
          await done()
          return
        }
        const generation = await inbox.beginGeneration(job.owner_id, job.holder, delivery)
        if (!generation.generate) {
          await done()
          return
        }
        await controlledEffect(pool, job.event_id)
        process.stdout.write(JSON.stringify({ phase: 'effect_committed', eventId: job.event_id }) + '\n')
        if (settings.phase === 'hold_effect') {
          await new Promise(() => {})
          return
        }
        checkpoint = {
          messages: [
            {
              role: 'assistant',
              content: `[Controlled Workflow transport fixture; NOT a model] event ${job.event_id} completed.`,
            },
          ],
          warning: null,
        }
        await inbox.checkpoint(job.owner_id, job.holder, delivery, checkpoint.messages)
        process.stdout.write(JSON.stringify({ phase: 'checkpointed', eventId: job.event_id }) + '\n')
        if (settings.phase === 'hold_checkpoint') {
          await new Promise(() => {})
          return
        }
      }
      await inbox.acknowledge(job.owner_id, job.holder, delivery, checkpoint.messages, checkpoint.warning)
      process.stdout.write(JSON.stringify({ phase: 'result_committed', eventId: job.event_id }) + '\n')
      if (settings.phase === 'hold_result_ack') {
        await new Promise(() => {})
        return
      }
      await done()
    } catch {
      await inbox.fail(job.owner_id, job.holder, delivery).catch(() => {})
      await done()
    }
    async function done() {
      // Lose in-flight transport runs on OS restart. Only the formal shared inbox
      // sweep may replace their delivery; this fixture never recovers one itself.
      await pool.query("UPDATE wake_control_jobs SET state='done' WHERE token=$1", [job.token])
    }
  }
}
main().catch((e) => {
  process.stderr.write(String(e))
  process.exitCode = 1
})

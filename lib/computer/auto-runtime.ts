import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { subscriptionsUsableSql } from '@/lib/personal-policy'

type Actor = { userId: string; workspaceId: string }
export type BotCloudRuntime = { botId: string; harness: 'codex' | 'claude_code'; agentId: string }

/** Wakes the bot's cloud computer and its worker, which records the bot's
 * runtime rows (`ensureBotRuntime`). Tests replace it; production uses E2B. */
export const botRuntimeProvisioner = {
  provision: async (pool: Pool, actor: Actor, botId: string) => {
    const { ComputerStore } = await import('./store')
    await new ComputerStore(pool).operate(actor, botId, 'wake')
    await (await import('./wake-worker')).ensureCloudBotWorker(pool, actor, botId)
  },
}

async function findRuntime(pool: Pool, actor: Actor, botId: string, harness: string) {
  return (await pool.query<BotCloudRuntime>(`SELECT "botId",harness,"agentId" FROM bot_cloud_runtimes
    WHERE "botId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND ($4='auto' OR harness=$4) ORDER BY harness LIMIT 1`,
  [botId, actor.userId, actor.workspaceId, harness])).rows[0] ?? null
}

/** The runtime's Agent uses the owner's own connected subscription for its
 * harness when nothing is bound yet (orchestration § 2). A saved binding wins. */
async function bindOwnSubscription(pool: Pool, actor: Actor, runtime: BotCloudRuntime, model: string) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(model)) return
  const route = runtime.harness === 'codex' ? 'codex_cli' : 'claude_code_cli'
  const provider = runtime.harness === 'codex' ? 'codex' : 'claude'
  const hash = createHash('sha256').update(JSON.stringify(['auto-runtime-binding', actor.userId, runtime.agentId, route])).digest('hex')
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
    SELECT $1,$2,$3,$4,c.id,c.epoch,$5,$6 FROM byos_connections c
    WHERE c."ownerId"=$2 AND c.provider=$7 AND c.state='connected' AND c.paused=false AND ${subscriptionsUsableSql('$2', '$3')}
      AND NOT EXISTS (SELECT 1 FROM byos_bindings b WHERE b."ownerId"=$2 AND b."consumerId"=$4 AND b.route=$5)
    ORDER BY c."createdAt" DESC,c.id LIMIT 1 ON CONFLICT (id) DO NOTHING`,
  [id, actor.userId, actor.workspaceId, runtime.agentId, route, model, provider])
}

/**
 * The bot's own cloud runtime for a run, created on first use with no manual
 * step: its cloud computer is woken and its runtime recorded. Idempotent; a
 * second dispatch reuses the runtime. Returns null when the cloud refuses, so
 * the run takes the next machine (decision 2026-10-31-2200-run-machine-fallback).
 */
export async function ensureBotCloudRuntime(pool: Pool, actor: Actor, botId: string, target: { harness: string; model?: string }, provisioner = botRuntimeProvisioner) {
  let runtime = await findRuntime(pool, actor, botId, target.harness)
  if (!runtime) {
    try { await provisioner.provision(pool, actor, botId) } catch { return null }
    runtime = await findRuntime(pool, actor, botId, target.harness)
    if (!runtime) return null
  }
  if (target.model) await bindOwnSubscription(pool, actor, runtime, target.model)
  return runtime
}

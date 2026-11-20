import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { botChatResourceId } from '@/lib/resource-access/store'
import { secretMaskerFor } from '@/lib/secrets/runtime'
import { maskDeep } from '@/lib/secrets/mask'
import { InteropError } from './errors'
import { aclParams, aclPredicate, admitPrincipal, principalSender, requireInterop, type InteropPrincipal } from './principal'

const uuid = z.uuid()
const CHAT_LIMIT = 40
const PART_LIMIT = 4_000

export interface InteropBot { id: string; name: string; publicRole: string; ownedByOwner: boolean }

/** Bots of the principal's tenant it may discover. Only public fields. */
export async function listInteropBots(principal: InteropPrincipal): Promise<InteropBot[]> {
  await admitPrincipal(principal)
  const [owner] = aclParams(principal)
  const { rows } = await pool.query<{ id: string; name: string; publicRole: string; ownerId: string | null }>(
    `SELECT b.id,b.name,b."publicRole",b."ownerId" FROM bots b
     WHERE b."workspaceId"=$1 AND b."archivedAt" IS NULL AND b."ownerId" IS NOT NULL
       AND ${aclPredicate(2, '$1', 'bot', 'b.id', 'canDiscover')}
     ORDER BY b.name, b.id LIMIT 100`, [principal.workspaceId, ...aclParams(principal)])
  return rows.map(row => ({ id: row.id, name: row.name, publicRole: row.publicRole, ownedByOwner: row.ownerId === owner }))
}

type BotTarget = { id: string; ownerId: string; workspaceId: string; name: string }

async function botTarget(principal: InteropPrincipal, botId: string): Promise<BotTarget> {
  if (!uuid.safeParse(botId).success) throw new InteropError('interop_not_found')
  await admitPrincipal(principal)
  const { rows: [bot] } = await pool.query<{ ownerId: string | null; workspaceId: string; name: string }>(
    'SELECT "ownerId","workspaceId",name FROM bots WHERE id=$1 AND "archivedAt" IS NULL', [botId])
  if (!bot?.ownerId || bot.workspaceId !== principal.workspaceId) throw new InteropError('interop_not_found')
  return { id: botId, ownerId: bot.ownerId, workspaceId: bot.workspaceId, name: bot.name }
}

/** Visible text of one AI SDK model message; tool calls and their payloads are omitted. */
export function modelMessageText(message: Record<string, unknown>): string {
  const content = message.content
  if (typeof content === 'string') return content.slice(0, PART_LIMIT)
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n').slice(0, PART_LIMIT)
}

/**
 * The newest messages of the Bot owner's chat with this Bot, oldest first.
 * Needs `canReadContent` on that chat, which only its owner has by default.
 */
export async function readBotChat(principal: InteropPrincipal, botId: string, limit = CHAT_LIMIT): Promise<{ botId: string; name: string; messages: { role: string; text: string; createdAt: string }[] }> {
  const bot = await botTarget(principal, botId)
  await requireInterop(principal, { kind: 'chat', id: botChatResourceId(bot.ownerId, bot.id) }, 'canReadContent')
  const { rows } = await pool.query<{ message: Record<string, unknown>; createdAt: Date }>(
    `SELECT message,"createdAt" FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2 ORDER BY position DESC LIMIT $3`,
    [bot.ownerId, bot.id, Math.max(1, Math.min(limit, CHAT_LIMIT))])
  const messages = rows.reverse().flatMap(row => {
    const role = typeof row.message.role === 'string' ? row.message.role : 'unknown'
    const text = modelMessageText(row.message)
    return (role === 'user' || role === 'assistant') && text ? [{ role, text, createdAt: row.createdAt.toISOString() }] : []
  })
  const mask = await secretMaskerFor({ workspaceId: bot.workspaceId, ownerId: bot.ownerId })
  return maskDeep({ botId: bot.id, name: bot.name, messages }, mask)
}

/**
 * Hand a peer message to a Bot and wake it for a turn. It enters as runtime
 * evidence (`run_report`, tier `result`), never as a message from the person,
 * so it starts a turn without paging anyone and cannot pose as a human request.
 */
export async function sendToBot(principal: InteropPrincipal, input: { botId: string; text: string; key: string }): Promise<{ eventId: string; duplicate: boolean }> {
  const parsed = z.object({ botId: z.uuid(), text: z.string().trim().min(1).max(10_000), key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) }).safeParse(input)
  if (!parsed.success) throw new InteropError('interop_invalid_request', { cause: parsed.error })
  const bot = await botTarget(principal, parsed.data.botId)
  await requireInterop(principal, { kind: 'bot', id: bot.id }, 'canSteer')
  const sender = principalSender(principal)
  if (sender.kind === 'bot' && sender.id === bot.id) throw new InteropError('interop_invalid_request')
  const dedupeKey = `interop:${sender.kind}:${sender.id}:${bot.id}:${parsed.data.key}`
  const { rows: [inserted] } = await pool.query<{ id: string }>(
    `INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier)
     VALUES ($1,$2,$3,'run_report',$4,$5,'result') ON CONFLICT ("dedupeKey") DO NOTHING RETURNING id`,
    [randomUUID(), bot.ownerId, bot.id, dedupeKey, JSON.stringify({ text: parsed.data.text, source: 'peer', from: sender })])
  if (!inserted) {
    const { rows: [existing] } = await pool.query<{ id: string; botId: string }>('SELECT id,"botId" FROM coordinator_events WHERE "dedupeKey"=$1', [dedupeKey])
    if (!existing || existing.botId !== bot.id) throw new InteropError('interop_send_unavailable', { detail: 'bot_unavailable' })
    return { eventId: existing.id, duplicate: true }
  }
  // The event is committed; the outbox sweep repairs a failed wake.
  const { wakeCoordinator } = await import('@/lib/coordinator/wake')
  await wakeCoordinator(bot.ownerId)
  return { eventId: inserted.id, duplicate: false }
}

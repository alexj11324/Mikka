import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { ActionFailureError } from '@/lib/action-error'
import { pool } from '@/lib/db'
import { ExecutionSettings } from '@/lib/execution-settings'
import { botModelMenu, botModelScope, refreshBotModelMenu } from '@/lib/bot-model-menu'
import { tokenWorkspace } from '@/lib/tokens/principal'

export const dynamic = 'force-dynamic'

const botParam = z.uuid().nullable()
const choice = z.strictObject({ bot: botParam, id: z.uuid() })

function failed(error: unknown) {
  if (error instanceof ActionFailureError && (error.code === 'botNotFound' || error.code === 'workspaceAccessDenied')) return json({ error: 'botNotFound' }, 404)
  if (error instanceof ActionFailureError && error.code === 'executionModelUnknown') return json({ error: 'modelUnavailable' }, 409)
  throw error
}

/** `GET /api/mobile/model?bot=<id>`: the composer's model menu for a bot, or the Coordinator (no `bot`). */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const bot = botParam.safeParse(new URL(request.url).searchParams.get('bot'))
  if (!bot.success) return json({ error: 'invalidBot' }, 400)
  try {
    const scope = await botModelScope(user.id, bot.data, user[tokenWorkspace])
    return json(await botModelMenu(pool, new ExecutionSettings(pool), scope, bot.data))
  } catch (error) { return failed(error) }
}

/**
 * `PUT /api/mobile/model` with `{ bot, id }`: saves the pick for the bot's next
 * runs and returns the menu. 409 `modelUnavailable` when the credential is not
 * usable here any more.
 */
async function handlePUT(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = choice.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidModel' }, 400)
  try {
    const scope = await botModelScope(user.id, body.data.bot, user[tokenWorkspace])
    const settings = new ExecutionSettings(pool)
    await settings.setBotModel(scope, body.data.bot, body.data.id)
    return json(await botModelMenu(pool, settings, scope, body.data.bot))
  } catch (error) { return failed(error) }
}

/** `POST /api/mobile/model` with `{ bot }`: 刷新, re-reads the menu after asking each subscription for its models. */
async function handlePOST(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const body = z.strictObject({ bot: botParam }).safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidBot' }, 400)
  try {
    const scope = await botModelScope(user.id, body.data.bot, user[tokenWorkspace])
    return json(await refreshBotModelMenu(pool, new ExecutionSettings(pool), scope, body.data.bot))
  } catch (error) { return failed(error) }
}

export const GET = withRequestLog('/api/mobile/model', handleGET)
export const PUT = withRequestLog('/api/mobile/model', handlePUT)
export const POST = withRequestLog('/api/mobile/model', handlePOST)

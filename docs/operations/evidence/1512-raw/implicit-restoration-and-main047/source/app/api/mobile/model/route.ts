import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { ActionFailureError } from '@/lib/action-error'
import { pool } from '@/lib/db'
import { ExecutionSettings } from '@/lib/execution-settings'
import { botModelMenu, botModelScope, chooseBotModel, refreshBotModelMenu } from '@/lib/bot-model-menu'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { openChatBotId } from '@/lib/coordinator/coordinator-bot'

export const dynamic = 'force-dynamic'

const botParam = z.uuid().nullable()
// An option id as the menu lists it: a binding uuid, Mikka 默认, or `apikey:<keyId>:<model>` (lib/bot-model-menu-view.ts).
const choice = z.strictObject({ bot: botParam, id: z.string().min(1).max(300) })
const temporaryChoice = z.strictObject({ bot: z.uuid(), id: z.uuid(), mode: z.literal('temporary-if-absent') })
const restoreChoice = z.strictObject({ bot: z.uuid(), mode: z.literal('restore-implicit'), bindingId: z.uuid(), revision: z.string().regex(/^[0-9]{1,10}$/) })
const putChoice = z.union([choice, temporaryChoice, restoreChoice])

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
    const botId = await openChatBotId(user, bot.data)
    const scope = await botModelScope(user.id, botId, user[tokenWorkspace])
    if (new URL(request.url).searchParams.get('choiceState') === '1')
      return json(await botModelMenu(pool, new ExecutionSettings(pool), scope, botId, Date.now(), true))
    return json(await botModelMenu(pool, new ExecutionSettings(pool), scope, botId))
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
  const body = putChoice.safeParse(await request.json().catch(() => null))
  if (!body.success) return json({ error: 'invalidModel' }, 400)
  try {
    const botId = await openChatBotId(user, body.data.bot)
    const scope = await botModelScope(user.id, botId, user[tokenWorkspace])
    if ('mode' in body.data) {
      if (!botId) return json({ error: 'invalidBot' }, 400)
      const settings = new ExecutionSettings(pool)
      if (body.data.mode === 'restore-implicit') {
        const restored = await settings.restoreTemporaryBotModel(scope, botId, body.data)
        return restored ? json({ restored: true, preferenceState: 'absent' }) : json({ error: 'modelChanged' }, 409)
      }
      const temporarySelection = await settings.setTemporaryBotModel(scope, botId, body.data.id)
      if (!temporarySelection) return json({ error: 'modelChanged' }, 409)
      return json({ ...await botModelMenu(pool, settings, scope, botId), temporarySelection })
    }
    return json(await chooseBotModel(pool, new ExecutionSettings(pool), scope, botId, body.data.id))
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
    const botId = await openChatBotId(user, body.data.bot)
    const scope = await botModelScope(user.id, botId, user[tokenWorkspace])
    return json(await refreshBotModelMenu(pool, new ExecutionSettings(pool), scope, botId))
  } catch (error) { return failed(error) }
}

export const GET = withRequestLog('/api/mobile/model', handleGET)
export const PUT = withRequestLog('/api/mobile/model', handlePUT)
export const POST = withRequestLog('/api/mobile/model', handlePOST)

import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { forbiddenOrigin, json, mobileUser, unauthorized, writeAllowed } from '@/lib/mobile-api'
import { ActionFailureError } from '@/lib/action-error'
import { preferencesPatch, readPreferences, savePreferences } from '@/lib/preferences'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/preferences`: the 通知 and 记忆 settings. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  return json(await readPreferences(user.id))
}

/**
 * `PATCH /api/mobile/preferences` with any of the settings; returns all of them.
 * 400 `invalidPreferences` for a malformed patch, 409 `dailySuggestionsNeedMemory`
 * when 每日建议 is turned on while 记忆 is off.
 */
async function handlePATCH(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  if (!writeAllowed(request)) return forbiddenOrigin()
  const patch = preferencesPatch.safeParse(await request.json().catch(() => null))
  if (!patch.success) return json({ error: 'invalidPreferences' }, 400)
  try {
    return json(await savePreferences(user.id, patch.data))
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'dailySuggestionsNeedMemory') return json({ error: error.code }, 409)
    throw error
  }
}

export const GET = withRequestLog('/api/mobile/preferences', handleGET)
export const PATCH = withRequestLog('/api/mobile/preferences', handlePATCH)

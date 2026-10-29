import { z } from 'zod'
import { COMPOSIO_AUTH_CALLBACK_PATH } from '@/lib/auth-return'
import { withBasePath } from '@/lib/base-path'
import { safeReturnPath } from '@/lib/composio-accounts'

/** Holds the `ComposioFlow` between starting a link and its callback. */
export const COMPOSIO_FLOW_COOKIE = 'mikka_composio_flow'

/**
 * The connect flow in progress, kept in an httpOnly cookie on the callback
 * path: the link it started (`link`, the new connected account id), the
 * account a reconnect replaces, and where to return.
 */
const composioFlowSchema = z.object({
  link: z.string().min(1).max(255),
  replace: z.string().min(1).max(255).optional(),
  returnTo: z.string().max(512).optional(),
}).strict()
export type ComposioFlow = z.infer<typeof composioFlowSchema>

export function encodeComposioFlow(flow: ComposioFlow) {
  return Buffer.from(JSON.stringify(flow)).toString('base64url')
}

export function decodeComposioFlow(value: string | undefined): ComposioFlow | null {
  if (!value || value.length > 2048) return null
  try {
    const parsed = composioFlowSchema.safeParse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')))
    if (!parsed.success) return null
    const returnTo = parsed.data.returnTo === undefined ? undefined : safeReturnPath(parsed.data.returnTo) ?? undefined
    return { ...parsed.data, returnTo }
  } catch {
    return null
  }
}

/** One set of cookie options for setting and clearing, so `secure` always matches. */
export function composioFlowCookieOptions(requestUrl: string, maxAge: number) {
  return { path: withBasePath(COMPOSIO_AUTH_CALLBACK_PATH), httpOnly: true, sameSite: 'lax' as const, secure: new URL(requestUrl).protocol === 'https:', maxAge }
}

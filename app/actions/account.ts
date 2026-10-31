'use server'

import { headers } from 'next/headers'
import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { auth } from '@/lib/auth'
import { appOrigin } from '@/lib/mcp/resource'
import { withBasePath } from '@/lib/base-path'
import { checkAvatarFile } from '@/lib/account/avatar-file'
import { saveAvatar } from '@/lib/account/avatar'
import { listSignedInDevices, sessionTokenFor, type SignedInDevice } from '@/lib/account/sessions'
import { EXPORT_LINK_TTL_MS, releaseExport, reserveExport } from '@/lib/account/export'
import { accountMailConfigured, sendAccountMail } from '@/lib/account/mail'
import { listSharedArtifacts, type SharedArtifactLink } from '@/lib/account/shared-links'
import { deleteAccount as deleteAccountData } from '@/lib/account/delete'

const displayName = z.string().trim().min(1).max(80)
// Better Auth's defaults (minPasswordLength 8, maxPasswordLength 128); lib/auth.ts does not change them.
const password = z.string().min(8).max(128)

/** The signed-in person and the session this request came with. Every action starts here; nothing trusts a user id from the client. */
async function requireSession() {
  const requestHeaders = await headers()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session?.user || !session.session) throw new ActionFailureError('authRequired')
  return { user: session.user, session: session.session, headers: requestHeaders }
}

/** Better Auth's error code, when the call failed with one. */
function authErrorCode(error: unknown): string | undefined {
  const body = (error as { body?: { code?: unknown } } | null)?.body
  return typeof body?.code === 'string' ? body.code : undefined
}

/** The person's own display name; the settings page shows and edits it. */
export async function updateDisplayName(name: string): Promise<ActionResult<{ name: string }>> {
  return runAction(async () => {
    const parsed = displayName.safeParse(name)
    if (!parsed.success) throw new ActionFailureError('validationNameRequired')
    const { headers: requestHeaders } = await requireSession()
    await auth.api.updateUser({ body: { name: parsed.data }, headers: requestHeaders })
    return { name: parsed.data }
  })
}

/**
 * 「更换」头像: a FormData with the picture under `avatar` (PNG, JPEG or WebP,
 * at most 200 KB; the client shrinks it to 256 px first). Returns the new
 * `user.image` path; show it through avatarImageSrc (lib/default-avatar.ts).
 */
export async function uploadAvatar(form: FormData): Promise<ActionResult<{ image: string }>> {
  return runAction(async () => {
    const { user, headers: requestHeaders } = await requireSession()
    const file = form.get('avatar')
    if (!(file instanceof Blob)) throw new ActionFailureError('avatarInvalidType')
    if (file.size > 200 * 1024) throw new ActionFailureError('avatarTooLarge')
    const checked = checkAvatarFile(file.type, new Uint8Array(await file.arrayBuffer()))
    if (!checked.ok) throw new ActionFailureError(checked.reason === 'size' ? 'avatarTooLarge' : 'avatarInvalidType')
    const image = await saveAvatar(user.id, checked.contentType, checked.bytes)
    await auth.api.updateUser({ body: { image }, headers: requestHeaders })
    return { image }
  })
}

/** Whether the account has a password: 「修改密码」 when it does, 「设置密码」 for an account that only signs in with Google or GitHub. */
export async function getPasswordStatus(): Promise<ActionResult<{ hasPassword: boolean }>> {
  return runAction(async () => {
    const { headers: requestHeaders } = await requireSession()
    const accounts = await auth.api.listUserAccounts({ headers: requestHeaders })
    return { hasPassword: accounts.some(account => account.providerId === 'credential') }
  })
}

/**
 * 「修改密码」: needs the current password. With `revokeOtherSessions` every
 * other device is signed out; this one stays signed in.
 */
export async function changePassword(input: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean }): Promise<ActionResult<{ revokedOtherSessions: boolean }>> {
  return runAction(async () => {
    const parsed = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string(), revokeOtherSessions: z.boolean().optional() }).safeParse(input)
    if (!parsed.success) throw new ActionFailureError('passwordIncorrect')
    checkNewPassword(parsed.data.newPassword)
    const { headers: requestHeaders } = await requireSession()
    const revokeOtherSessions = parsed.data.revokeOtherSessions ?? false
    try {
      await auth.api.changePassword({ body: { currentPassword: parsed.data.currentPassword, newPassword: parsed.data.newPassword, revokeOtherSessions }, headers: requestHeaders })
    } catch (error) {
      throw passwordFailure(error) ?? error
    }
    return { revokedOtherSessions: revokeOtherSessions }
  })
}

/** 「设置密码」 for an account without one (Google/GitHub only), so it can also sign in with email and password. */
export async function setPassword(input: { newPassword: string }): Promise<ActionResult<{ hasPassword: true }>> {
  return runAction(async () => {
    const parsed = z.object({ newPassword: z.string() }).safeParse(input)
    if (!parsed.success) throw new ActionFailureError('passwordTooShort')
    checkNewPassword(parsed.data.newPassword)
    const { headers: requestHeaders } = await requireSession()
    try {
      await auth.api.setPassword({ body: { newPassword: parsed.data.newPassword }, headers: requestHeaders })
    } catch (error) {
      throw passwordFailure(error) ?? error
    }
    return { hasPassword: true as const }
  })
}

function checkNewPassword(value: string) {
  const parsed = password.safeParse(value)
  if (!parsed.success) throw new ActionFailureError(value.length < 8 ? 'passwordTooShort' : 'passwordTooLong')
}

function passwordFailure(error: unknown): ActionFailureError | null {
  switch (authErrorCode(error)) {
    case 'INVALID_PASSWORD': return new ActionFailureError('passwordIncorrect')
    case 'CREDENTIAL_ACCOUNT_NOT_FOUND': return new ActionFailureError('passwordNotSet')
    case 'PASSWORD_ALREADY_SET': return new ActionFailureError('passwordAlreadySet')
    case 'PASSWORD_TOO_SHORT': return new ActionFailureError('passwordTooShort')
    case 'PASSWORD_TOO_LONG': return new ActionFailureError('passwordTooLong')
    default: return null
  }
}

/** 「登录设备」: every signed-in session of this account, the current one first and marked. */
export async function listSessions(): Promise<ActionResult<{ sessions: SignedInDevice[] }>> {
  return runAction(async () => {
    const { user, session } = await requireSession()
    return { sessions: await listSignedInDevices(user.id, session.id) }
  })
}

/** Signs one other device out. The current device signs out with 「退出登录」 instead. */
export async function revokeSession(sessionId: string): Promise<ActionResult<{ revoked: true }>> {
  return runAction(async () => {
    const parsed = z.string().min(1).max(200).safeParse(sessionId)
    if (!parsed.success) throw new ActionFailureError('sessionNotFound')
    const { user, session, headers: requestHeaders } = await requireSession()
    if (parsed.data === session.id) throw new ActionFailureError('sessionIsCurrent')
    const token = await sessionTokenFor(user.id, parsed.data)
    if (!token) throw new ActionFailureError('sessionNotFound')
    await auth.api.revokeSession({ body: { token }, headers: requestHeaders })
    return { revoked: true as const }
  })
}

/** 「退出其他所有设备」: every session of this account except this one. */
export async function revokeOtherSessions(): Promise<ActionResult<{ revoked: number }>> {
  return runAction(async () => {
    const { user, session, headers: requestHeaders } = await requireSession()
    const before = await listSignedInDevices(user.id, session.id)
    await auth.api.revokeOtherSessions({ headers: requestHeaders })
    return { revoked: before.filter(device => !device.current).length }
  })
}

/**
 * 「导出我的数据」: emails the person a download link to all their data as
 * JSON. The link works for 24 hours and only while signed in as them. One
 * request per hour. Says it was sent only once the email provider accepted it.
 */
export async function requestDataExport(): Promise<ActionResult<{ email: string; expiresAt: string; downloadPath?: string }>> {
  return runAction(async () => {
    const { user } = await requireSession()
    const reservation = await reserveExport(user.id)
    if (!reservation.ok) throw new ActionFailureError('dataExportRateLimited', { minutes: reservation.retryAfterMinutes })
    const path = withBasePath(`/api/account/export/${reservation.token}`)
    const expiresAt = reservation.expiresAt.toISOString()
    // Without mail the link is handed straight to this signed-in page; the
    // download route still only opens for this account and until it expires.
    if (!accountMailConfigured() || !appOrigin) return { email: user.email, expiresAt, downloadPath: path }
    const t = await getTranslations('AccountEmail')
    const outcome = await sendAccountMail({
      to: user.email,
      subject: t('exportSubject'),
      text: t('exportBody', { url: `${appOrigin}${path}`, email: user.email, hours: EXPORT_LINK_TTL_MS / 3_600_000 }),
    })
    if (outcome === 'unavailable') return { email: user.email, expiresAt, downloadPath: path }
    if (outcome !== 'sent') {
      await releaseExport(user.id, reservation.id)
      throw new ActionFailureError('emailDeliveryFailed')
    }
    return { email: user.email, expiresAt }
  })
}

/** 「已共享的链接」: the person's artifacts with live share links. Stop one with stopSharingArtifact (app/actions/artifacts.ts). */
export async function listSharedLinks(): Promise<ActionResult<{ links: SharedArtifactLink[] }>> {
  return runAction(async () => {
    const { user } = await requireSession()
    return { links: await listSharedArtifacts(user.id) }
  })
}

/**
 * 「删除账户」: permanently deletes the account and what it owns (lib/account/delete.ts).
 * `email` is what the person typed in the confirmation and must be the account's
 * email. Refused while they are the only active admin of a workspace others belong to.
 * On success this browser is signed out; send the person to the sign-in page.
 */
export async function deleteAccount(input: { email: string }): Promise<ActionResult<{ deleted: true }>> {
  return runAction(async () => {
    const { user, headers: requestHeaders } = await requireSession()
    const typed = z.object({ email: z.string().max(320) }).safeParse(input)
    if (!typed.success || typed.data.email.trim().toLowerCase() !== user.email.toLowerCase()) throw new ActionFailureError('accountEmailMismatch')
    const outcome = await deleteAccountData(user.id, user.email)
    if (!outcome.ok && 'pending' in outcome) throw new ActionFailureError('accountDeletionPending')
    if (!outcome.ok) throw new ActionFailureError('accountSoleAdmin', { workspaces: outcome.soleAdminOf.join(', '), count: outcome.soleAdminOf.length })
    // The sessions went with the user row; this clears the cookie too.
    await auth.api.signOut({ headers: requestHeaders }).catch(() => undefined)
    return { deleted: true as const }
  })
}

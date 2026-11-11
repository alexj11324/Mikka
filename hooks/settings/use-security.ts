'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { changePassword, revokeOtherSessions, revokeSession, setPassword, type getPasswordStatus, type listSessions } from '@/app/actions/account'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { useActionError } from '@/lib/use-action-error'
import type { SignedInDevice } from '@/lib/account/sessions'

export type NewPassword = { current: string; next: string; revokeOthers: boolean }

/**
 * 安全 (N1): the password and the signed-in devices. The open-source page and
 * the hosted layer draw it each in their own look (docs/ui-overlay.md); the
 * reads and saves are these.
 */
export function useSecurity() {
  const actionError = useActionError()
  const password = useSWR(settingsKeys.password(), () => settingsRead<Awaited<ReturnType<typeof getPasswordStatus>>>('password'))
  const sessions = useSWR(settingsKeys.sessions(), () => settingsRead<Awaited<ReturnType<typeof listSessions>>>('sessions'))
  const [pendingSession, setPendingSession] = useState<string | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const passwordStatus = password.data && !('error' in password.data) ? password.data : null
  const passwordError = password.data && 'error' in password.data ? actionError(password.data.error) : password.error ? actionError() : null
  const hasPassword = passwordStatus?.hasPassword ?? null
  const devices: SignedInDevice[] = sessions.data && !('error' in sessions.data) ? sessions.data.sessions : []
  const devicesLoading = !sessions.data && !sessions.error
  /** Why the device list could not be read, or a fixed message when the read itself failed */
  const devicesError = sessions.data && 'error' in sessions.data ? actionError(sessions.data.error) : sessions.error ? '' : null

  /** Sets or changes the password; the error to show, or null once saved and read again. */
  async function savePassword({ current, next, revokeOthers }: NewPassword): Promise<string | null> {
    if (hasPassword === null) return passwordError ?? actionError()
    try {
      const result = hasPassword
        ? await changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: revokeOthers })
        : await setPassword({ newPassword: next })
      if (result.error) return actionError(result.error)
      void password.mutate()
      void sessions.mutate()
      return null
    } catch { return actionError() }
  }

  async function signOut(sessionId: string) {
    setPendingSession(sessionId)
    setSignOutError(null)
    try {
      const result = await revokeSession(sessionId)
      if (result.error) { setSignOutError(actionError(result.error)); return }
      void sessions.mutate()
    } catch {
      setSignOutError(actionError())
    } finally {
      setPendingSession(null)
    }
  }

  /** Signs out every device but this one; true once done. */
  async function signOutOthers(): Promise<boolean> {
    setPendingSession('all')
    setSignOutError(null)
    try {
      const result = await revokeOtherSessions()
      if (result.error) { setSignOutError(actionError(result.error)); return false }
      void sessions.mutate()
      return true
    } catch {
      setSignOutError(actionError())
      return false
    } finally {
      setPendingSession(null)
    }
  }

  return {
    passwordLoading: password.isLoading, passwordError, hasPassword, savePassword, reloadPassword: () => password.mutate(),
    devices, devicesLoading, devicesError, pendingSession, signOutError, signOut, signOutOthers,
  }
}

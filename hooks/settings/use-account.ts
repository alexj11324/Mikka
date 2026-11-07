'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { deleteAccount, updateDisplayName, uploadAvatar } from '@/app/actions/account'
import { clearPersistentReadCaches } from '@/lib/swr/persistent-cache'
import { withBasePath } from '@/lib/base-path'
import { shrinkAvatar } from '@/lib/account/avatar-client'
import { useActionError } from '@/lib/use-action-error'

/**
 * Saves the shown name; the error to show, or null once it is saved and the
 * page is read again. Shared by both builds' 名称 fields (docs/ui-overlay.md).
 */
export function useSaveDisplayName() {
  const actionError = useActionError()
  const router = useRouter()
  return async function saveDisplayName(name: string): Promise<string | null> {
    try {
      const result = await updateDisplayName(name)
      if (result.error) return actionError(result.error)
      router.refresh()
      return null
    } catch { return actionError() }
  }
}

/**
 * 账户 (V01): the picture and the way out of the account. The open-source page
 * and the hosted layer draw it each in their own look; the saves are these.
 */
export function useAccount() {
  const actionError = useActionError()
  const router = useRouter()
  const [uploading, setUploading] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  /** Shrinks and uploads a new picture; true once it is saved and the page is read again. */
  async function changeAvatar(file: File | undefined): Promise<boolean> {
    if (!file) return false
    setAvatarError(null)
    setUploading(true)
    try {
      const form = new FormData()
      form.set('avatar', await shrinkAvatar(file))
      const result = await uploadAvatar(form)
      if (result.error) { setAvatarError(actionError(result.error)); return false }
      router.refresh()
      return true
    } catch {
      setAvatarError(actionError())
      return false
    } finally {
      setUploading(false)
    }
  }

  /** Deletes the account once the typed email matches, then leaves for 登录. */
  async function remove(email: string) {
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await deleteAccount({ email: email.trim() })
      if (result.error) { setDeleteError(actionError(result.error)); return }
      await clearPersistentReadCaches()
      window.location.assign(withBasePath('/sign-in'))
    } catch {
      setDeleteError(actionError())
    } finally {
      setDeleting(false)
    }
  }

  return { uploading, avatarError, changeAvatar, deleting, deleteError, clearDeleteError: () => setDeleteError(null), remove }
}

'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { Camera } from 'lucide-react'
import { deleteAccount, uploadAvatar } from '@/app/actions/account'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { ProfileName } from '@/components/settings/profile-name'
import { withBasePath } from '@/lib/base-path'
import { avatarImageSrc } from '@/lib/default-avatar'
import { useActionError } from '@/lib/use-action-error'

/** Shrinks to 256px before upload; the server refuses anything over 200 KB. */
async function shrinkAvatar(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const side = Math.min(bitmap.width, bitmap.height, 256)
    const canvas = new OffscreenCanvas(side, side)
    const context = canvas.getContext('2d')
    if (!context) return file
    // Centre crop, so a wide photo is not squashed into an oval.
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, side, side)
    bitmap.close()
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
  } catch {
    return file
  }
}

/** V01: the account's identity, plus the two ways out. */
export function AccountSettings({ user, onSignOut, signingOut }: {
  user: { name: string; email: string; image?: string | null }
  onSignOut: () => void
  signingOut: boolean
}) {
  const t = useTranslations('Settings.profile')
  const actionError = useActionError()
  const router = useRouter()
  const picker = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const shownImage = avatarImageSrc(user.image)

  async function changeAvatar(file: File | undefined) {
    if (!file) return
    setAvatarError(null)
    setUploading(true)
    try {
      const form = new FormData()
      form.set('avatar', await shrinkAvatar(file))
      const result = await uploadAvatar(form)
      if (result.error) { setAvatarError(actionError(result.error)); return }
      router.refresh()
    } catch {
      setAvatarError(actionError())
    } finally {
      setUploading(false)
      if (picker.current) picker.current.value = ''
    }
  }

  async function remove() {
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await deleteAccount({ email: typed.trim() })
      if (result.error) { setDeleteError(actionError(result.error)); return }
      window.location.assign(withBasePath('/sign-in'))
    } catch {
      setDeleteError(actionError())
    } finally {
      setDeleting(false)
    }
  }

  return <>
    <SettingsSection id="account-heading" title={t('heading')}>
      <SettingRow title={t('avatar')}>
        <div className="flex items-center gap-3">
          <Avatar className="size-10">
            {shownImage && <AvatarImage src={shownImage} alt="" />}
            <AvatarFallback>{(user.name || user.email).slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <Input ref={picker} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label={t('changeAvatar')} onChange={event => { void changeAvatar(event.target.files?.[0]) }} />
          <Button type="button" variant="secondary" size="sm" disabled={uploading} onClick={() => picker.current?.click()}>
            <Camera data-icon="inline-start" />{uploading ? t('uploading') : t('changeAvatar')}
          </Button>
        </div>
      </SettingRow>
      {avatarError && <p role="alert" className="px-5 pb-3 text-sm text-destructive">{avatarError}</p>}
      <SettingRow title={t('name')}><ProfileName name={user.name || ''} /></SettingRow>
      <SettingRow title={t('email')}><span className="break-all">{user.email}</span></SettingRow>
    </SettingsSection>

    <SettingsSection id="session-heading" title={t('sessionHeading')}>
      <SettingRow title={t('signOut')}>
        <Button type="button" variant="secondary" size="sm" disabled={signingOut} onClick={onSignOut}>{signingOut ? t('signingOut') : t('signOut')}</Button>
      </SettingRow>
      <SettingRow title={t('deleteAccount')}>
        <Button type="button" variant="destructive" size="sm" onClick={() => { setTyped(''); setDeleteError(null); setConfirming(true) }}>{t('deleteAccount')}</Button>
      </SettingRow>
    </SettingsSection>

    <Dialog open={confirming} onOpenChange={setConfirming}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deleteTitle')}</DialogTitle>
          <DialogDescription>{t('deleteBody')}</DialogDescription>
        </DialogHeader>
        <Label className="flex flex-col items-start gap-2">
          {t('deleteConfirmLabel', { email: user.email })}
          <Input value={typed} onChange={event => setTyped(event.target.value)} placeholder={user.email} autoComplete="off" />
        </Label>
        {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={deleting}>{t('cancel')}</Button>
          <Button type="button" variant="destructive" disabled={deleting || typed.trim() !== user.email} onClick={() => { void remove() }}>{deleting ? t('deleting') : t('confirmDelete')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

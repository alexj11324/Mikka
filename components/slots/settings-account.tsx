'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Camera } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { ProfileName } from '@/components/settings/profile-name'
import { avatarImageSrc } from '@/lib/default-avatar'
import { FieldError } from '@/components/ui/field'
import { useAccount } from '@/hooks/settings/use-account'
import type { SettingsAccountProps } from '@/components/slots/settings-account-contract'

/** V01: the account's identity, plus the two ways out. */
export function AccountSettings({ user, onSignOut, signingOut }: SettingsAccountProps) {
  const t = useTranslations('Settings.profile')
  const { uploading, avatarError, changeAvatar: upload, deleting, deleteError, clearDeleteError, remove: removeAccount } = useAccount()
  const picker = useRef<HTMLInputElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const shownImage = avatarImageSrc(user.image)

  async function changeAvatar(file: File | undefined) {
    await upload(file)
    if (picker.current) picker.current.value = ''
  }
  const remove = () => removeAccount(typed)

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
      {avatarError && <FieldError className="px-5 pb-3">{avatarError}</FieldError>}
      <SettingRow title={t('name')}><ProfileName name={user.name || ''} /></SettingRow>
      <SettingRow title={t('email')}><span className="break-all">{user.email}</span></SettingRow>
    </SettingsSection>

    {/* Desktop only: which server this account is on (#1557). Renders nothing on the web. */}

    {/* The row names the thing, the button the action; deleting the account sits alone in 危险操作 (settings-pages). */}
    <SettingsSection id="session-heading">
      <SettingRow title={t('currentSession')}>
        <Button type="button" variant="secondary" size="sm" disabled={signingOut} onClick={onSignOut}>{signingOut ? t('signingOut') : t('signOut')}</Button>
      </SettingRow>
    </SettingsSection>

    <SettingsSection id="account-danger" title={t('danger')}>
      <SettingRow title={t('account')}>
        <Button type="button" variant="destructive" size="sm" onClick={() => { setTyped(''); clearDeleteError(); setConfirming(true) }}>{t('deleteAccount')}</Button>
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
          <Input value={typed} onChange={event => setTyped(event.target.value)} autoComplete="off" />
        </Label>
        {deleteError && <FieldError>{deleteError}</FieldError>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={deleting}>{t('cancel')}</Button>
          <Button type="button" variant="destructive" disabled={deleting || typed.trim() !== user.email} onClick={() => { void remove() }}>{deleting ? t('deleting') : t('confirmDelete')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

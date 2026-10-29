'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { updateDisplayName } from '@/app/actions/account'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useActionError } from '@/lib/use-action-error'

/** The name the person is shown by. Saves in place; a failure keeps what was typed. */
export function ProfileName({ name }: { name: string }) {
  const t = useTranslations('Settings.profile')
  const actionError = useActionError()
  const router = useRouter()
  const [value, setValue] = useState(name)
  const [saving, setSaving] = useState(false)
  const next = value.trim()
  const dirty = next !== name

  async function save() {
    setSaving(true)
    try {
      const result = await updateDisplayName(next)
      if (result.error) { toast.error(actionError(result.error)); return }
      toast.success(t('saved'))
      router.refresh()
    } catch { toast.error(actionError()) } finally {
      setSaving(false)
    }
  }

  return <div className="flex items-center gap-2">
    <Input aria-label={t('name')} value={value} maxLength={80} onChange={event => setValue(event.target.value)} />
    <Button size="sm" disabled={!dirty || saving || !next} onClick={() => { void save() }}>{t('save')}</Button>
  </div>
}

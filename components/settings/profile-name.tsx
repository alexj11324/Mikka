'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { updateDisplayName } from '@/app/actions/account'
import { Input } from '@/components/ui/input'
import { useActionError } from '@/lib/use-action-error'

/**
 * The name the person is shown by. Saves when the field is left or on Enter, like the
 * workspace name (settings-pages: one save model); Esc puts the saved name back.
 * A failure keeps what was typed.
 */
export function ProfileName({ name }: { name: string }) {
  const t = useTranslations('Settings.profile')
  const actionError = useActionError()
  const router = useRouter()
  const [value, setValue] = useState(name)
  const [saved, setSaved] = useState(name)
  const [saving, setSaving] = useState(false)
  // Enter followed by the blur must not send the same name twice.
  const inFlight = useRef(false)

  async function commit() {
    const next = value.trim()
    if (!next) { setValue(saved); return }
    if (next === saved || inFlight.current) return
    inFlight.current = true
    setSaving(true)
    try {
      const result = await updateDisplayName(next)
      if (result.error) { toast.error(actionError(result.error)); return }
      setSaved(next)
      setValue(next)
      toast.success(t('saved'))
      router.refresh()
    } catch { toast.error(actionError()) } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <Input aria-label={t('name')} className="w-full sm:w-50" value={value} maxLength={80} disabled={saving}
    onChange={event => setValue(event.target.value)} onBlur={() => { void commit() }}
    onKeyDown={event => { if (event.key === 'Enter') void commit(); if (event.key === 'Escape') setValue(saved) }} />
}

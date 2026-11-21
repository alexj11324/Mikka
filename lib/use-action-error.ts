'use client'

import { useTranslations } from '@/lib/intl/i18n-client'

import type { ActionErrorCode } from './action-result'

export function useActionError() {
  const t = useTranslations('Errors')
  return (code?: ActionErrorCode | string | null) => {
    if (!code) return t('generic')
    if (t.has(code as never)) return t(code as never)
    return /[^A-Za-z0-9_-]/.test(code) ? code : t('generic')
  }
}

'use client'

import { useTranslations } from 'next-intl'

import type { ActionErrorCode } from './action-result'

export function useActionError() {
  const t = useTranslations('Errors')
  return (code?: ActionErrorCode | string | null) => {
    if (!code) return t('generic')
    return t.has(code as never) ? t(code as never) : t('generic')
  }
}

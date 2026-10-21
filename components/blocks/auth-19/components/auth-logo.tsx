'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

export function AuthLogo({ className }: { className?: string }) {
  const t = useTranslations('Auth')
  return (
    <Link href="/" aria-label={t('home')} className={cn('inline-flex items-center gap-2', className)}>
      <span className="text-[0.9375rem] font-medium">Mikka</span>
    </Link>
  )
}

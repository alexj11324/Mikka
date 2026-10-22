'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { withBasePath } from '@/lib/base-path'
import { cn } from '@/lib/utils'

export function AuthLogo({ className }: { className?: string }) {
  const t = useTranslations('Auth')
  return (
    <Link href="/" aria-label={t('home')} className={cn('inline-flex items-center gap-2.5', className)}>
      {/* public/ assets are not under Next's automatic base path, hence withBasePath. */}
      <img src={withBasePath('/brand/mikka-icon-light.svg')} alt="" className="size-7 dark:hidden" />
      <img src={withBasePath('/brand/mikka-icon-dark.svg')} alt="" className="hidden size-7 dark:block" />
      <span className="text-lg font-semibold">Mikka</span>
    </Link>
  )
}

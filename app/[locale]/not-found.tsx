import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'

export default function NotFound() {
  const t = useTranslations('NotFound')
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Link href="/" className="text-sm underline underline-offset-4">{t('backHome')}</Link>
    </main>
  )
}

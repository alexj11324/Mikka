import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  const t = useTranslations('NotFound')
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-8 text-center">
      {/* The tab names the page too, not only "Mikka" (UI audit states-11). */}
      <title>{`${t('title')} · Mikka`}</title>
      <p className="text-sm text-muted-foreground tabular-nums">404</p>
      <h1 className="text-2xl font-semibold text-balance">{t('title')}</h1>
      <Button variant="outline" nativeButton={false} render={<Link href="/" />}>{t('backHome')}</Button>
    </main>
  )
}

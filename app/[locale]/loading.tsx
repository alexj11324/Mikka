import { useTranslations } from 'next-intl'

export default function Loading() {
  const t = useTranslations('Workspace')
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
      <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
        <span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
        {t('loadingEditor')}
      </div>
    </main>
  )
}

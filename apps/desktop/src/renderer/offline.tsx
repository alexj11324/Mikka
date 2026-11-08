import { useTranslations } from 'next-intl'
import { paths } from 'mikka:native-offline'

/** The HTML fallback supplies this card's exact styles and icon geometry at
 * build time. Only transport/retry handling changes for the local React app. */
export function Offline({ pending, status, retry }: { pending: boolean; status?: number; retry: () => void }) {
  const t = useTranslations('DesktopRenderer')
  const network = !navigator.onLine
  // Mikka answered with a server error: say so, rather than blame the connection.
  const serverError = !network && status !== undefined && status >= 500
  return <main className="desktop-offline"><section>
    <svg className="pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[network ? 'network' : 'server'].map(path => <path key={path} d={path} />)}
    </svg>
    <h1>{t(network ? 'networkUnavailable' : serverError ? 'serverError' : 'serverUnavailable')}</h1>
    <p className="status" role="status" aria-live="polite">{pending ? t('reconnecting') : serverError ? t('serverErrorStatus', { status: status ?? 500 }) : t('offlineHint')}</p>
    <a href={location.href} onClick={event => { event.preventDefault(); if (!pending) retry() }}>{t('retry')}</a>
  </section></main>
}

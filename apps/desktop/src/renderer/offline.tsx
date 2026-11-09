import { useTranslations } from 'next-intl'
import { paths } from 'mikka:native-offline'

/** The HTML fallback supplies this card's exact styles and icon geometry at
 * build time. Only transport/retry handling changes for the local React app. */
export function Offline({ pending, retry }: { pending: boolean; retry: () => void }) {
  const t = useTranslations('DesktopRenderer')
  const network = !navigator.onLine
  return <main className="desktop-offline"><section>
    <svg className="pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[network ? 'network' : 'server'].map(path => <path key={path} d={path} />)}
    </svg>
    <h1>{t(network ? 'networkUnavailable' : 'serverUnavailable')}</h1>
    <p className="status" role="status" aria-live="polite">{t(pending ? 'reconnecting' : 'offlineHint')}</p>
    <a href={location.href} onClick={event => { event.preventDefault(); if (!pending) retry() }}>{t('retry')}</a>
  </section></main>
}

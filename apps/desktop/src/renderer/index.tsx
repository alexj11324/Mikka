import { createRoot } from 'react-dom/client'
import { App } from './app'
import { installNavigation, isClientRoute } from './location'
import { activeHref, persistableHref, readSavedTabs } from './saved-tabs'
import { withBasePath } from '@/lib/base-path'
import './styles.css'
import { markStartup } from '../startup'

markStartup('renderer.entry')
installNavigation()
// Restore the last main-window workspace before React's first paint. Child
// windows deliberately remain independent and never replace the main tab set.
if (document.documentElement.dataset.desktopWindow === 'main') {
  try {
    const tabs = readSavedTabs(window.localStorage)
    const href = tabs ? persistableHref(activeHref(tabs)) : null
    if (href) {
      const url = new URL(withBasePath(href), window.location.href)
      if (isClientRoute(url)) window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
  } catch { /* An inaccessible local store should not prevent the app opening. */ }
}
// Set the same saved/system theme before the first local paint. The web's
// next-themes inline bootstrap is unnecessary in this CSP-restricted document.
let theme: string | null = null
try { theme = localStorage.getItem('theme') } catch { /* OS theme remains available */ }
const dark = theme === 'dark' || (theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
document.documentElement.classList.toggle('dark', dark)
document.documentElement.classList.toggle('light', !dark)
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'

const root = document.getElementById('root')
if (!root) throw new Error('desktop_root_missing')
createRoot(root).render(<App />)

import { createRoot } from 'react-dom/client'
import { App } from './app'
import { installNavigation } from './location'
import './styles.css'

installNavigation()
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

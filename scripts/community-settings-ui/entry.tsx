// Screenshot composition only: the existing SettingsView owns workspace reads,
// edition filtering, legacy-section fallback and every Preferences control.
import { createRoot } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { ThemeProvider } from 'next-themes'
import { SWRConfig } from 'swr'
import { AppFrame } from '@/components/app-shell'
import { SettingsView } from '@/components/settings/settings-view'
import { resolveSettingsSection } from '@/lib/settings-sections'
import zh from '@/messages/zh-CN.json'
import '../../apps/desktop/src/renderer/styles.css'

const query = new URL(window.location.href).searchParams
const initialSection = resolveSettingsSection('/settings', query.get('section'))
const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.documentElement.lang = 'zh-CN'
document.documentElement.classList.add(theme)
document.documentElement.style.colorScheme = theme
const root = document.getElementById('root')
if (!root) throw new Error('visual_root_missing')
createRoot(root).render(
  <NextIntlClientProvider locale="zh-CN" messages={zh} timeZone="UTC">
    <ThemeProvider attribute="class" defaultTheme={theme} disableTransitionOnChange>
      <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }}>
        <AppFrame settings bar={null} rail={null}>
          <SettingsView
            user={{ name: 'Synthetic reviewer', email: 'synthetic-review@example.invalid' }}
            userKey="synthetic-settings-review-user"
            workspaceId="10000000-0000-4000-8000-000000000001"
            initialSection={initialSection}
            onRail={() => {}}
            onSignOut={() => {}}
            signingOut={false}
            accountError=""
          />
        </AppFrame>
      </SWRConfig>
    </ThemeProvider>
  </NextIntlClientProvider>,
)

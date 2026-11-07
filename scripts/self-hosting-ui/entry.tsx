// Screenshot composition only. These are the existing production components,
// fonts, tokens and content width; no product route imports this entry.
import { createRoot } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { SWRConfig } from 'swr'
import { CloudSettings, CloudModelSettings } from '@/components/settings/cloud-settings'
import { GitHubAppSettings } from '@/components/plugins/github-app-settings'
import { SettingsContent } from '@/components/ui/settings-layout'
import zh from '@/messages/zh-CN.json'
import en from '@/messages/en.json'
import '../../apps/desktop/src/renderer/styles.css'

const query = new URL(window.location.href).searchParams
const locale = query.get('locale') === 'en' ? 'en' : 'zh-CN'
const messages = locale === 'en' ? en : zh
const view = query.get('view')
const dark = matchMedia('(prefers-color-scheme: dark)').matches
document.documentElement.lang = locale
document.documentElement.classList.add(dark ? 'dark' : 'light')
document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
const userId = 'synthetic-visual-review-user', workspaceId = '10000000-0000-4000-8000-000000000001'
const title = view === 'github' ? messages.Settings.integrations.githubApp
  : view === 'models' ? messages.Settings.sections.models.title
  : view === 'personal' ? messages.Settings.sections.account.title : messages.Settings.cloud.title
const root = document.getElementById('root')
if (!root) throw new Error('visual_root_missing')
createRoot(root).render(
  <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
    <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false, revalidateOnReconnect: false }}>
      <main>
        <SettingsContent className="gap-6">
          <h1 className="text-xl font-semibold">{title}</h1>
          {view === 'github' ? <GitHubAppSettings userId={userId} />
            : view === 'models' ? <CloudModelSettings userKey={userId} workspaceId={workspaceId} />
            : <CloudSettings personal={view === 'personal'} userKey={userId} workspaceId={workspaceId} />}
        </SettingsContent>
      </main>
    </SWRConfig>
  </NextIntlClientProvider>,
)

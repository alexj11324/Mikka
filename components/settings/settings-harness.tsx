'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { AppShell, AppShellContent } from '@/components/app-shell'
import { BotsSettings } from '@/components/settings/bots-settings'
import { SettingsContent } from '@/components/ui/settings-layout'
import { createMockBotsApi, type BotsMockScenario } from '@/lib/settings/bots-mock'

import type { SettingsHarnessSection } from '@/lib/settings/harness-sections'

/** DEV-ONLY: see app/[locale]/preview/settings-harness/[section]/page.tsx. */
export function SettingsHarness({ section, state }: { section: SettingsHarnessSection; state: string }) {
  const t = useTranslations('Settings')
  const title = t(`sections.${section}.title`)
  const body = useMemo(() => {
    switch (section) {
      case 'bots': return <BotsSettings api={createMockBotsApi(state as BotsMockScenario)} />
    }
  }, [section, state])
  return <AppShell variant="settings">
    <AppShellContent parent={t('title')} title={title} variant="settings">
      <SettingsContent className="gap-6"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{body}</SettingsContent>
    </AppShellContent>
  </AppShell>
}

'use client'

import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { BotPermissionsPage } from '@ui-slot/settings-bot-permissions'
import { AppTile, OWN_APPS, appState, useAppInfo, useConnectedApps } from '@/components/plugins/connected-apps'
import { OWN_APP_STATES_KEY, fetchOwnAppStates } from '@/components/plugins/plugins-view'
import type { BotPermissionAction, BotPermissions, SettingsBotPermissionsProps } from '@/components/slots/settings-bot-permissions-contract'

/** The write actions Mikka asks about by name today (lib/operations/write-provider.ts), by toolkit. */
const NAMED_WRITES: Record<string, string[]> = {
  slack: ['send_slack_message'],
  notion: ['append_notion_paragraph'],
  googlecalendar: ['cancel_calendar_event'],
}

/**
 * What a Bot may do in each connected app, as #1832's API will return it, filled from today's one rule: it reads on
 * its own and asks before every write (approved-write-actions). Same for every Bot, so the page names none.
 */
export function useBotPermissions(): BotPermissions | null {
  const t = useTranslations('Settings.botPermissions')
  const tAction = useTranslations('Coordinator.pendingActions')
  const info = useAppInfo()
  const apps = useConnectedApps()
  const own = useSWR(OWN_APP_STATES_KEY, () => fetchOwnAppStates())
  if (apps.loading || (!own.data && !own.error)) return null
  const actionsOf = (id: string): BotPermissionAction[] => [
    { id: `${id}:read`, name: t('read'), kind: 'read', level: 'allow' },
    ...(NAMED_WRITES[id]?.map(action => ({ id: `${id}:${action}`, name: tAction(action as never), kind: 'write' as const, level: 'ask' as const }))
      ?? [{ id: `${id}:write`, name: t('write'), kind: 'write' as const, level: 'ask' as const }]),
  ]
  const composio = apps.connectedToolkits().flatMap(id => {
    const accounts = apps.accountsFor(id)
    const state = appState(accounts)
    if (!state.on) return []
    const account = state.usable.find(item => item.enabled)
    const { name, iconUrl } = info(id)
    return [{ id, name, account: account?.alias ?? account?.email ?? null, iconUrl, actions: actionsOf(id) }]
  })
  const ownApps = OWN_APPS.filter(id => own.data?.states[id] === 'connected').map(id => ({ id, name: info(id).name, account: null, iconUrl: null, actions: actionsOf(id) }))
  return { mode: 'careful', apps: [...ownApps, ...composio], redLines: [], editable: false }
}

export function BotPermissionsSettings() {
  return <BotPermissionsPage permissions={useBotPermissions()} />
}

/** The open-source page: the rule in one line, then each app with what it does on its own and what it asks about. */
export function BotPermissionsView({ permissions }: SettingsBotPermissionsProps) {
  const t = useTranslations('Settings.botPermissions')
  if (!permissions) return <p role="status" className="text-sm text-muted-foreground">{t('loading')}</p>
  return <div className="flex flex-col gap-4">
    <p className="text-sm text-muted-foreground">{t('notice')}</p>
    {permissions.apps.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p>
      : <ul className="flex flex-col divide-y rounded-xl border">
        {permissions.apps.map(app => <li key={app.id} className="flex items-start gap-3 px-4 py-3">
          <AppTile app={app.id} iconUrl={app.iconUrl} />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium">{app.name}{app.account && <span className="ml-2 font-normal text-muted-foreground">{app.account}</span>}</p>
            <p className="text-xs text-muted-foreground">{app.actions.map(action => `${action.name} · ${t(`level.${action.level}`)}`).join('，')}</p>
          </div>
        </li>)}
      </ul>}
  </div>
}

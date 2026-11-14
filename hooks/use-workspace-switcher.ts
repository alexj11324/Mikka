'use client'

import { useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { toast } from 'sonner'
import { authClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'
import { rememberWorkspaceBeforeSwitch } from '@/lib/settings-navigation'
import { getPathname } from '@/i18n/navigation'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import { switchWorkspace } from '@/app/actions/workspace'
import { clearPersistentReadCaches } from '@/lib/swr/persistent-cache'

/**
 * The account menu's data and actions: the signed-in accounts' workspaces,
 * switching, 添加账户, 新建工作区 and the ⌘, shortcut to 设置. The open-source
 * menu and the hosted layer draw it each in their own look (docs/ui-overlay.md).
 * `onShortcut` runs before ⌘, opens settings, so a menu can close itself.
 */
export function useWorkspaceSwitcher({ user, onSettings, signingOut, onBeforeChange, onShortcut }: {
  user: { email: string }
  onSettings: (href?: string) => void
  signingOut: boolean
  onBeforeChange?: (action: () => Promise<void>) => void
  onShortcut?: () => void
}) {
  const i18nText = useTranslations();
  const locale = useLocale()
  const { data, error, mutate } = useSWR('/api/workspace/switcher', fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  const [pending, setPending] = useState(false)
  // While the switcher loads or fails, the avatar keeps the workspace's last known initial, never the placeholder
  // word's first character (「工」 from 工作区); with none known, the avatar stays blank.
  const nameKey = `mikka:workspace-name:${user.email}`
  const [lastName, setLastName] = useState<string | null>(null)
  useEffect(() => {
    try {
      if (data) window.localStorage.setItem(nameKey, data.workspace.name)
      else setLastName(window.localStorage.getItem(nameKey))
    } catch { /* storage unavailable */ }
  }, [data, nameKey])
  const knownName = data?.workspace.name ?? lastName ?? ''
  const workspaceName = knownName || i18nText("Settings.groups.workspace")
  const busy = pending || signingOut
  const shortcutDone = useRef(onShortcut)
  useEffect(() => { shortcutDone.current = onShortcut })
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.isComposing || event.keyCode === 229 || event.repeat || pending || signingOut || event.altKey || event.shiftKey) return
      if (!(event.ctrlKey || event.metaKey) || event.code !== 'Comma') return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"]')) return
      event.preventDefault()
      shortcutDone.current?.()
      onSettings('/settings')
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [onSettings, pending, signingOut])
  function run(action: () => Promise<void>) {
    if (busy) return
    if (onBeforeChange) onBeforeChange(action)
    else void action()
  }
  function selectWorkspace(accountId: string, workspaceId?: string) {
    if (accountId === data?.accounts[0]?.id && workspaceId === data.workspace.id) return
    run(async () => {
      setPending(true)
      try {
        const result = await switchWorkspace({ accountId, workspaceId })
        if (!result.ok) { toast.error(result.error); return }
        await clearPersistentReadCaches({ documentNavigation: true })
        if (accountId === data?.accounts[0]?.id) rememberWorkspaceBeforeSwitch(data.workspace.id)
        const selected = result.data.workspaceId
        const href = selected ? { pathname: '/', query: { workspace: selected } } : '/'
        window.location.assign(withBasePath(getPathname({ locale, href })))
      } catch { toast.error(i18nText("FeatureCopy.c_b8e346ef")) }
      finally { setPending(false) }
    })
  }
  function addAccount() {
    run(async () => {
      setPending(true)
      try {
        const session = await authClient.getSession({ query: { disableCookieCache: true } })
        if (session.error || !session.data?.user) throw new Error('Session unavailable')
        if ((data?.accounts.length ?? 0) >= 5) { toast.error(i18nText("FeatureCopy.c_a2a50802")); return }
        window.location.assign(withBasePath('/sign-in?addAccount=1'))
      } catch { toast.error(i18nText("FeatureCopy.c_c9988ff5")) }
      finally { setPending(false) }
    })
  }
  /** `onStart` runs once a pending change has let the move go ahead (a phone's open sidebar closes). */
  function newWorkspace(onStart?: () => void) {
    run(async () => { onStart?.(); window.location.assign(withBasePath('/workspaces/new')) })
  }
  return { data, error, mutate, busy, knownName, workspaceName, selectWorkspace, addAccount, newWorkspace }
}

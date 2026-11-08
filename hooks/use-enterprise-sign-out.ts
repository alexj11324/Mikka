'use client'

import { useCallback } from 'react'
import { clearChatDrafts } from '@/lib/chat-drafts'
import { clearPersistentReadCaches } from '@/lib/swr/persistent-cache'
import { bridgeFromWindow } from '@/lib/platform/detect'
import { currentWebServers } from '@/lib/web-connection/browser'
import { enterpriseSignOutStep, readLogoutTarget, submitSignOutForm, type EnterpriseSignOutStep } from '@/lib/enterprise/logout-client'

type Fetch = (input: string, init?: RequestInit) => Promise<Response>
export type EnterpriseSignOutRuntime = {
  /** The browser's own cookie session on this origin: not the desktop bridge, not a selected web server. */
  cookieSession: boolean
  origin: string
  fetch?: Fetch
  /** Clears what endSession clears in this tab, before the browser leaves. */
  forget: () => Promise<void>
  go: (step: EnterpriseSignOutStep) => void
}

/**
 * Routes this session's sign-out through its company sign-in when it has one
 * (#1669). Resolves false when there is none (`target: null`), when this runtime
 * has no cookie session to navigate, or when the route cannot be read: the
 * caller then runs the existing sign-out, unchanged. Resolves true once the
 * browser is leaving: OIDC to the url its 200 JSON logout returned; SAML by a
 * native top-level form POST (urlencoded) whose 302 to the IdP the browser
 * follows itself. A failed OIDC logout POST rejects. Sign-in for both
 * protocols is unrelated: it starts from sign-in/sso's 200 JSON url.
 */
export async function routeEnterpriseSignOut(runtime: EnterpriseSignOutRuntime): Promise<boolean> {
  if (!runtime.cookieSession) return false
  const target = await readLogoutTarget(runtime.fetch).catch(() => null)
  if (!target) return false
  const step = await enterpriseSignOutStep(target, { origin: runtime.origin, fetch: runtime.fetch })
  await runtime.forget()
  runtime.go(step)
  return true
}

function browserRuntime(): EnterpriseSignOutRuntime {
  const browser = typeof window !== 'undefined'
  return {
    cookieSession: browser && !bridgeFromWindow(window) && !currentWebServers()?.getActiveAccount(),
    origin: browser ? window.location.origin : '',
    forget: async () => { clearChatDrafts(); await clearPersistentReadCaches() },
    go: step => { if (step.kind === 'navigate') window.location.assign(step.url); else submitSignOutForm(step) },
  }
}

/** The account menu's sign-out route; see routeEnterpriseSignOut. */
export function useEnterpriseSignOut() {
  return useCallback(() => routeEnterpriseSignOut(browserRuntime()), [])
}

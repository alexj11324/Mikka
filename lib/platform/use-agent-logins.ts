'use client'

import { useEffect, useState } from 'react'

import type { AgentLogins } from '@mikka/protocol/bridge'

import { usePlatform } from './use-platform'

/**
 * Desktop only: how this computer's Claude Code / Codex CLIs are signed in
 * (Capy's 「Detected」). Read once per mount; null on the web, on an older
 * shell, or while it is being read.
 */
export function useAgentLogins(): AgentLogins | null {
  const platform = usePlatform()
  const read = platform.runtime === 'desktop' && platform.capabilities['device.agentLogins'] ? platform.bridge?.device.agentLogins : undefined
  const [logins, setLogins] = useState<AgentLogins | null>(null)
  useEffect(() => {
    if (!read) return
    let live = true
    read().then(found => { if (live) setLogins(found) }, () => {})
    return () => { live = false }
  }, [read])
  return logins
}

/** The subscription a provider's CLI is signed in with here, and its plan as a display name. */
export function detectedSubscription(logins: AgentLogins | null, provider: 'claude' | 'codex'): { plan: string | null } | null {
  const login = logins?.[provider === 'claude' ? 'claudeCode' : 'codex']
  if (login?.login !== 'subscription') return null
  return { plan: login.plan ? login.plan.charAt(0).toUpperCase() + login.plan.slice(1) : null }
}

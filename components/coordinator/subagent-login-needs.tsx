'use client'

import { useEffect, useState } from 'react'
import { CredentialLoginCard } from '@/components/credentials/credential-login-card'
import { applySubagentUpdate, loginNeeds, subscribeSubagentUpdates, type SubagentUpdate } from '@/lib/subagents/login-needs'

/** A sub-agent of this bot is waiting on a site login: offer the secure login card in the chat. */
export function SubagentLoginNeeds({ botId }: { botId: string }) {
  const [updates, setUpdates] = useState<ReadonlyMap<string, SubagentUpdate>>(() => new Map())
  useEffect(() => subscribeSubagentUpdates(update => setUpdates(state => applySubagentUpdate(state, update))), [])
  // Sub-agents whose login went through: the card stays on 已登录 until the sub-agent moves on.
  const [signedIn, setSignedIn] = useState<ReadonlySet<string>>(() => new Set())
  const needs = loginNeeds(updates, botId)
  if (!needs.length) return null
  return <div className="flex flex-col gap-3" data-testid="subagent-login-needs" data-signed-in={signedIn.size}>
    {needs.map(need => <CredentialLoginCard key={`${need.subagentId}:${need.origin}`} prefix={need.prefix} origin={need.origin} name={need.name} onSignedIn={() => setSignedIn(state => new Set(state).add(need.subagentId))} />)}
  </div>
}

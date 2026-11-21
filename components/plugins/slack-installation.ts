'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { withBasePath } from '@/lib/base-path'
import { openPathInBrowser } from '@/lib/platform/open-settings'
import { publicServiceLink } from '@/lib/platform/public-origin'

type Installation = {
  teamName: string
  connected: boolean
  enabled: boolean
  watched: string[]
  canUninstall: boolean
  revoking: boolean
}
type Status = {
  viewerId: string
  workspaceId: string
  configured: boolean
  installation: Installation | null
  channels: { id: string; name: string }[]
}
type Operation =
  { operation: 'connect' | 'unlink' | 'uninstall' } | { operation: 'configure'; enabled: boolean; watched: string[] }
const route = '/api/integrations/slack'

async function read([, viewer, workspace, channels]: readonly [string, string, string, boolean]) {
  const query = new URLSearchParams({ workspaceId: workspace, ...(channels ? { channels: '1' } : {}) })
  const response = await fetch(withBasePath(route) + '?' + query, { cache: 'no-store' })
  if (!response.ok) throw new Error('slackReadFailed')
  const data = (await response.json()) as Status
  if (data.viewerId !== viewer || data.workspaceId !== workspace || !Array.isArray(data.channels))
    throw new Error('slackReadFailed')
  return data
}

/** The encrypted grant remains on the service. Web, Desktop and mobile use the same account-bound browser handoff. */
export function useSlackInstallation(viewer: string, workspace: string) {
  const [selecting, setSelecting] = useState(false)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<'handoff' | 'actionFailed' | null>(null)
  const result = useSWR([route, viewer, workspace, selecting] as const, read, {
    keepPreviousData: false,
    shouldRetryOnError: false,
  })
  async function act(operation: Operation) {
    if (working) return false
    setWorking(true)
    setNotice(null)
    try {
      const response = await fetch(withBasePath(route), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...operation, viewerId: viewer, workspaceId: workspace }),
      })
      if (!response.ok) throw new Error('slackActionFailed')
      if (operation.operation === 'connect') {
        const { intent } = (await response.json()) as { intent?: string }
        if (typeof intent !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(intent)) throw new Error('slackActionFailed')
        const path = route + '/connect?intent=' + encodeURIComponent(intent)
        const target = publicServiceLink(path)
        const handoff = await openPathInBrowser(target)
        if (handoff === 'browser') window.location.assign(target)
        else if (handoff === 'desktop') setNotice('handoff')
        else throw new Error('slackActionFailed')
      } else {
        await result.mutate()
      }
      return true
    } catch {
      setNotice('actionFailed')
      void result.mutate().catch(() => undefined)
      return false
    } finally {
      setWorking(false)
    }
  }
  return { result, selecting, setSelecting, working, notice, act }
}

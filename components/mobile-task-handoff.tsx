'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { Button } from '@/components/ui/button'
import { FieldError } from '@/components/ui/field'
import { withBasePath } from '@/lib/base-path'
import { cloudAuthClient } from '@/lib/auth-client'
import { mobileTaskTarget } from '@/lib/mobile-task-handoff'
import { currentWebServers, signInToServer } from '@/lib/web-connection/browser'
import { canResumeMobileTask, showMobileTaskLocation } from '@/lib/web-connection/mobile-task-location'
import { selectedWorkspaceId } from '@/lib/workspace-selection'

type Launch = { server: string; ref: string }
type Target = { target: string; workspaceId: string; userId: string }

function validTarget(value: Partial<Target> | null): value is Target {
  return !!value && !!mobileTaskTarget(value.target) && !!selectedWorkspaceId(value.workspaceId) && typeof value.userId === 'string'
}

export default function MobileTaskHandoff({ launch }: { launch: Launch }) {
  const t = useTranslations('MobileHandoff')
  const [pending, setPending] = useState(false), [failed, setFailed] = useState(false)
  const busy = useRef(false)
  const { server, ref } = launch
  const directory = currentWebServers()
  const cloud = server === new URL(withBasePath('/'), window.location.origin).href.replace(/\/$/, '')

  const open = useCallback(async (resume = false) => {
    if (!directory || busy.current) return
    busy.current = true
    const document = window.location.href
    setPending(true); setFailed(false)
    try {
      const saved = window.history.state?.mobileTask
      const restore = saved?.server === server && saved?.ref === ref && validTarget(saved)
      if (cloud && (directory.getActiveAccount() || directory.getSnapshot().expiredServer)) await directory.switchServer(null)
      if (!cloud && (!restore || !resume || directory.getActiveAccount()?.server !== server)) await signInToServer(server, true)
      const snapshot = directory.getSnapshot()
      if (window.location.href !== document || snapshot.expiredServer || (cloud ? snapshot.account !== null : snapshot.account?.server !== server)) throw Error()
      let result: Target
      if (restore) {
        const user = cloud ? (await cloudAuthClient.getSession({ query: { disableCookieCache: true } })).data?.user : (await directory.readSession())?.user
        if (user?.id !== saved.userId) throw Error()
        result = saved
      } else {
        const response = await directory.fetch(server + '/api/mobile/open', { method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref }) })
        if (!response.ok) throw Error()
        result = await response.json()
      }
      if (window.location.href !== document || !validTarget(result) || directory.getSnapshot().version !== snapshot.version || (!cloud && result.userId !== snapshot.account?.user.id)) throw Error()
      const query = new URLSearchParams(result.target.slice(2))
      query.set('workspace', result.workspaceId)
      showMobileTaskLocation(document, query)
      window.history.replaceState({ ...window.history.state, mobileTask: { server, ref, ...result } }, '', window.location.href)
    } catch { setFailed(true) }
    finally { busy.current = false; setPending(false) }
  }, [cloud, directory, ref, server])

  // A reload can restore only a previously claimed destination. Verify the
  // browser's current identity before exposing its route to the shared app.
  useEffect(() => {
    const saved = window.history.state?.mobileTask
    if (directory && saved?.server === server && saved?.ref === ref && validTarget(saved)
      && canResumeMobileTask(server, cloud, saved.userId, directory.getSnapshot())) void open(true)
  }, [cloud, directory, open, ref, server])

  return <Auth><AuthCard title={t('title')} description={server}>
    <Button disabled={pending || !directory} onClick={() => void open()}>{t('confirm')}</Button>
    {failed && <FieldError>{t('openUnconfirmed')}</FieldError>}
  </AuthCard></Auth>
}

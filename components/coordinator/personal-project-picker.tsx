'use client'

import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { withBasePath } from '@/lib/base-path'
import { personalProjectSelection } from '@/lib/project-input'

type Selection = z.infer<typeof personalProjectSelection>
type Read = { scope: string; data?: Selection; error?: boolean }

export function usePersonalProjectPicker(readerId?: string, workspaceId?: string) {
  const scope = readerId && workspaceId ? JSON.stringify([readerId, workspaceId]) : null
  const url = readerId && workspaceId
    ? withBasePath('/api/workspaces/' + encodeURIComponent(workspaceId) + '/personal-default-project') : null
  const [read, setRead] = useState<Read | null>(null)
  const [version, setVersion] = useState(0)
  const [writing, setWriting] = useState<string | null>(null)
  const writeInFlight = useRef(false)
  const activeScope = useRef(scope)
  const current = read?.scope === scope ? read : null
  useEffect(() => {
    activeScope.current = scope
    setRead(null)
    if (!url || !scope) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal, headers: { 'x-mikka-reader-id': readerId! } })
        if (!response.ok) throw Error()
        const data = personalProjectSelection.parse(await response.json())
        if (!controller.signal.aborted) setRead({ scope, data })
      } catch {
        if (!controller.signal.aborted) setRead({ scope, error: true })
      }
    })()
    return () => controller.abort()
  }, [scope, readerId, url, version])
  const data = current?.data
  const project = data?.projects.find(item => item.id === data.projectId)
  // A default project is a convenience, never a precondition: a read that fails
  // (a solo account has no organization to hold one, or the request simply
  // lost) leaves `project` undefined and the task is created without one. It
  // used to hold `pending` true and block the dialog behind "无项目", so a
  // person with no projects could not create a task at all.
  const pending = Boolean(scope && (!current || writing === scope))
  async function choose(projectId: string | null) {
    if (!url || !scope || !data?.organizationId || writeInFlight.current) return
    writeInFlight.current = true
    setWriting(scope)
    try {
      const response = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ readerId, organizationId: data.organizationId, expectedRevision: data.revision, projectId }) })
      if (!response.ok) throw Error()
      const updated = personalProjectSelection.parse(await response.json())
      if (activeScope.current === scope) setRead({ scope, data: updated })
    } catch {
      if (activeScope.current === scope) setRead({ scope, error: true })
    } finally {
      writeInFlight.current = false
      setWriting(null)
    }
  }
  return { data, project, pending, error: current?.error === true, choose, reload: () => setVersion(value => value + 1) }
}

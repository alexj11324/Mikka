'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { withBasePath } from '@/lib/base-path'
import { projectVisibilityDefault, type ProjectVisibilityDefault } from '@/lib/project-input'

async function requestDefault(workspaceId: string, init?: RequestInit) {
  const path = '/api/workspaces/' + encodeURIComponent(workspaceId) + '/project-visibility-default'
  const response = await fetch(withBasePath(path), { cache: 'no-store', ...init })
  if (!response.ok) throw new Error('projectVisibilityDefault')
  return projectVisibilityDefault.parse(await response.json())
}

export function useProjectVisibilityDefault(readerId: string, workspaceId?: string) {
  const { data, error, mutate } = useSWR(workspaceId ? ['project-visibility-default', readerId, workspaceId] : null,
    ([, , id]: [string, string, string]) => requestDefault(id), { shouldRetryOnError: false })
  const [saving, setSaving] = useState(false)
  const [writeError, setWriteError] = useState(false)
  async function change(visibility: ProjectVisibilityDefault['visibility']) {
    if (!workspaceId || !data?.organizationId || saving) return
    setSaving(true)
    setWriteError(false)
    try {
      const updated = await requestDefault(workspaceId, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: data.organizationId, expectedVisibility: data.visibility, visibility }) })
      await mutate(updated, { revalidate: false })
    } catch {
      setWriteError(true)
      await mutate().catch(() => undefined)
    } finally { setSaving(false) }
  }
  return { data: error ? undefined : data, error: Boolean(error), writeError, saving, change, refresh: () => mutate().catch(() => undefined) }
}

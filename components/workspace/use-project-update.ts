'use client'

import { useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { updateProjectProperties } from '@/app/actions/projects'
import type { ProjectChanges } from '@/lib/project-input'
import type { Project } from './project-properties'

export function useProjectUpdate(onUpdated: () => void) {
  const { mutate } = useSWRConfig()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const saving = useRef(false)
  async function update(project: Project, changes: ProjectChanges) {
    if (saving.current) return
    saving.current = true; setPending(true); setError('')
    try {
      const result = await updateProjectProperties({ id: project.id, revision: project.revision, changes })
      if (!result.project) { setError(result.error ?? '保存失败，请重试。'); return }
      const saved = result.project
      await mutate(key => Array.isArray(key) && key[0] === 'projects', (current: Project[] | undefined) => current?.map(item => item.id === saved.id ? saved : item), { revalidate: false })
      onUpdated()
    } catch { setError('保存失败，原属性未更改，请重试。') }
    finally { saving.current = false; setPending(false) }
  }
  return { update, pending, error }
}

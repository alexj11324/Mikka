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
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const outstanding = useRef(0)
  const latest = useRef(new Map<string, Project>())
  function update(project: Project, changes: ProjectChanges): Promise<boolean> {
    outstanding.current += 1
    setPending(true)
    const operation = queue.current.then(async () => {
      setError('')
      try {
        const cached = latest.current.get(project.id)
        const current = cached && cached.revision > project.revision ? cached : project
        const result = await updateProjectProperties({ id: project.id, revision: current.revision, changes })
        if (!result.project) { setError(result.error ?? '保存失败，请重试。'); return false }
        const saved = result.project
        latest.current.set(saved.id, saved)
        await mutate(key => Array.isArray(key) && key[0] === 'projects', (items: Project[] | undefined) => items?.map(item => item.id === saved.id ? saved : item), { revalidate: false })
        onUpdated()
        return true
      } catch { setError('保存失败，修改内容尚未保存，请重试。'); return false }
      finally { outstanding.current -= 1; setPending(outstanding.current > 0) }
    })
    queue.current = operation
    return operation
  }
  return { update, pending, error }
}

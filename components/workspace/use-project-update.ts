'use client'

import { useRef, useState } from 'react'
import { useActionError } from '@/lib/use-action-error'
import { updateProjectProperties } from '@/app/actions/projects'
import type { ProjectChanges } from '@/lib/project-input'
import type { Project } from './project-properties'

export function useProjectUpdate(onUpdated: () => void) {
  const translateError = useActionError()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const outstanding = useRef(0)
  const latest = useRef(new Map<string, Project>())
  function update(project: Project, changes: ProjectChanges): Promise<boolean> {
    if (project.canEditProperties === false) return Promise.resolve(false)
    outstanding.current += 1
    setPending(true)
    const operation = queue.current.then(async () => {
      setError('')
      try {
        const cached = latest.current.get(project.id)
        const current = cached && cached.revision > project.revision ? cached : project
        // An unrelated property patch still carries the compatibility members array.
        // Keep the latest canonical membership if an earlier queued edit changed it.
        const patch = changes.properties && !changes.memberIds ? { ...changes, memberIds: current.memberIds } : changes
        const result = await updateProjectProperties({ id: project.id, revision: current.revision, workspaceId: project.workspaceId, changes: patch })
        if ('error' in result) { setError(translateError(result.error)); onUpdated(); return false }
        const saved = result.project
        latest.current.set(saved.id, saved)
        // A saved Project includes this viewer's permissions. Refresh the bound list for this session.
        onUpdated()
        return true
      } catch { setError(translateError('projectSaveFailed')); return false }
      finally { outstanding.current -= 1; setPending(outstanding.current > 0) }
    })
    queue.current = operation
    return operation
  }
  return { update, pending, error }
}

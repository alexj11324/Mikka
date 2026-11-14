'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import useSWR from 'swr'
import { toast } from 'sonner'
import { setIssueScope, type IssueView } from '@/app/actions/issues'
import type { TaskDetailRow } from '@/components/slots/task-detail-contract'
import { useActionError } from '@/lib/use-action-error'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'

type OwnershipTask = Pick<IssueView, 'id' | 'userId' | 'revision' | 'workspaceId' | 'ownershipState' | 'linearSyncPolicy' | 'linearSyncBlocked' | 'linearTargetVerified'>

/** Workspace membership is fixed at creation. The switcher's existing authorized
 * read can name that exact ID; the independent Linear command only disables sync. */
export function useTaskOwnershipRows(task: OwnershipTask, viewerId: string, preview: boolean, locked: boolean, onSaved: (issue: IssueView) => void): TaskDetailRow[] {
  const t = useTranslations('Issue.scope')
  const errorText = useActionError()
  const { data: switcher } = useSWR<WorkspaceSwitcher>(preview ? null : '/api/workspace/switcher', null)
  const account = switcher?.accounts[0]
  const workspaceId = !preview && task.ownershipState === 'bound' ? task.workspaceId : null
  const name = account?.id === viewerId ? account.choices.find(choice => choice.id === workspaceId)?.name : undefined
  const rows: TaskDetailRow[] = [{
    id: 'workspace', label: t('workspace'),
    value: { text: name || workspaceId || t('workspaceUnavailable'), mark: { kind: 'icon', icon: 'workspace' } },
  }]

  const request = useRef<symbol | null>(null)
  const [saving, setSaving] = useState(false)
  useLayoutEffect(() => {
    setSaving(false)
    return () => { request.current = null }
  }, [task.id, task.revision, viewerId, locked, preview])

  const enabled = task.linearSyncPolicy === 'explicit' && task.linearSyncBlocked === false
  if (!workspaceId || !enabled) return rows
  const canDisable = !locked && task.userId === viewerId
  async function disable() {
    if (!canDisable || request.current) return
    const token = Symbol()
    request.current = token
    setSaving(true)
    try {
      const result = await setIssueScope({ id: task.id, revision: task.revision, scope: 'personal' })
      if (request.current !== token) return
      if (!('issue' in result) || !result.issue) { toast.error(errorText(result.error)); return }
      const saved = result.issue
      if (saved.id !== task.id || saved.workspaceId !== workspaceId) { toast.error(errorText('issueStale')); return }
      onSaved(saved)
      if (saved.linearSyncPolicy === 'disabled' && saved.linearSyncBlocked) toast.success(t('linearDisabled'))
      else toast.error(errorText('issueStale'))
    } catch {
      if (request.current === token) toast.error(errorText('generic'))
    } finally {
      if (request.current === token) { request.current = null; setSaving(false) }
    }
  }
  rows.push({
    id: 'linearSync', label: t('linearSync'), value: { text: t('linearEnabled') }, disabled: locked || saving,
    menu: canDisable ? [{ id: 'disable', label: t(task.linearTargetVerified ? 'disableLinkedLinear' : 'disableLinear'), onSelect: () => { void disable() } }] : undefined,
  })
  return rows
}

'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { memberCsv } from '@/lib/invitation-csv'
import { revokeWorkspaceInvitation, updateWorkspaceMember } from '@/app/actions/workspace'
import { fetchSettingsData, memberSettingsKey } from '@/lib/settings-data'
import { useActionError } from '@/lib/use-action-error'
import { useInviteMembers } from '@/hooks/settings/use-invite-members'

export type MemberChange = { userId: string; name: string; role: 'admin' | 'member'; status: 'active' | 'suspended' }
export type WorkspaceMember = WorkspaceSettings['members'][number]
export type WorkspaceInvitation = WorkspaceSettings['invitations'][number]

/**
 * 设置 › 成员 as data, for a UI layer that draws the page itself (slot `settings-members`):
 * the same read, confirmations and actions as MembersSettings. A role change or a suspension
 * is asked first (`confirm`) and saved through updateWorkspaceMember once confirmed, one person
 * at a time (several picked rows go one after another). Invites come from useInviteMembers;
 * a pending invite can be revoked or made again (a new link for the same email and role).
 */
export function useWorkspaceMembers(workspaceId: string | undefined, inviteInitially = false) {
  const t = useTranslations('Members')
  const translateError = useActionError()
  // The same key the settings preloader fills, so members open from its cache.
  const { data, error: fetchError, mutate, isValidating } = useSWR<WorkspaceSettings>(memberSettingsKey(workspaceId), fetchSettingsData<WorkspaceSettings>, { revalidateOnMount: true })
  const [inviteOpen, setInviteOpen] = useState(false)
  const [changes, setChanges] = useState<MemberChange[] | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canManage = data?.role === 'admin' && !fetchError
  const invite = useInviteMembers(data?.workspace.id, () => mutate())
  useEffect(() => { if (inviteInitially && canManage) setInviteOpen(true) }, [inviteInitially, canManage])

  async function applyChanges() {
    if (!changes?.length || pending || !data) return
    setPending(true); setError(''); setNotice('')
    try {
      for (const change of changes) {
        const result = await updateWorkspaceMember({ workspaceId: data.workspace.id, ...change })
        if ('error' in result) { setError(translateError(result.error)); await mutate(); return }
      }
      setChanges(null)
      setNotice(t('memberUpdated'))
      await mutate()
    } catch {
      setError(t('updateFailed'))
    } finally { setPending(false) }
  }

  async function revoke(id: string) {
    if (pending || !data) return
    setPending(true); setError(''); setNotice('')
    try {
      const result = await revokeWorkspaceInvitation(data.workspace.id, id)
      if ('error' in result) { setError(translateError(result.error)); return }
      setNotice(t('invitationRevoked'))
      await mutate()
    } catch {
      setError(t('revokeFailed'))
    } finally { setPending(false) }
  }

  /** The given people as members.csv, the columns MembersSettings exports. */
  function exportCsv(members: WorkspaceMember[], invitations: WorkspaceInvitation[]) {
    const role = (value: string) => value === 'admin' ? t('role.admin') : t('role.member')
    const csv = memberCsv([
      [t('csv.name'), t('csv.email'), t('csv.role'), t('csv.status'), t('csv.joined')],
      ...members.map(member => [member.name, member.email, role(member.role), member.status === 'active' ? t('status.active') : t('status.suspended'), member.createdAt]),
      ...(canManage ? invitations : []).map(item => ['', item.email, role(item.role), t('status.invited'), item.expiresAt]),
    ])
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'members.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return {
    data, ready: Boolean(data), loading: !data && !fetchError, fetchError, refreshing: isValidating, retry: () => void mutate(), canManage,
    pending, error, notice, clearMessages: () => { setError(''); setNotice('') }, clearNotice: () => setNotice(''),
    /** Ask before a role change or suspension; nothing is saved until `applyChanges`. */
    confirm: (list: MemberChange[]) => { setError(''); setChanges(list.length ? list : null) },
    changes, cancelChanges: () => { if (!pending) { setChanges(null); setError('') } }, applyChanges,
    revoke, exportCsv,
    inviteOpen: inviteOpen && canManage, setInviteOpen, invite,
  }
}

export type WorkspaceMembers = ReturnType<typeof useWorkspaceMembers>

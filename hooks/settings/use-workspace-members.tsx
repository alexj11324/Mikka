'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { memberCsv } from '@/lib/invitation-csv'
import { revokeWorkspaceInvitation, updateWorkspaceMember } from '@/app/actions/workspace'
import { fetchSettingsData, memberSettingsKey } from '@/lib/settings-data'
import { useActionError } from '@/lib/use-action-error'
import { useRevalidateGovernance } from '@/hooks/settings/use-workspace-governance'
import { InviteMembersDialog } from '@/components/workspace/invite-members-dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { FieldError } from '@/components/ui/field'

/**
 * 成员 as data, for a UI layer that draws the page itself (slot `settings-members`):
 * the same reads, confirmations and actions as MembersSettings. A role change or
 * a suspension is confirmed first and saved through updateWorkspaceMember, one
 * person at a time (several picked rows go one after another); a member action
 * re-reads the member list and the governance seats it counts (#1662).
 */

export type MemberChange = { userId: string; name: string; role: 'admin' | 'member'; status: 'active' | 'suspended' }

export function useWorkspaceMembers(workspaceId: string | undefined, inviteInitially = false) {
  const t = useTranslations('Members')
  const translateError = useActionError()
  const { data, error: fetchError, mutate } = useSWR<WorkspaceSettings>(memberSettingsKey(workspaceId), fetchSettingsData<WorkspaceSettings>, { revalidateOnMount: true })
  const revalidateGovernance = useRevalidateGovernance()
  const [inviteOpen, setInviteOpen] = useState(false)
  const [changes, setChanges] = useState<MemberChange[] | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const canManage = data?.role === 'admin' && !fetchError
  useEffect(() => { if (inviteInitially && canManage) setInviteOpen(true) }, [inviteInitially, canManage])

  async function refresh() {
    await mutate()
    if (data?.workspace.id) void revalidateGovernance(data.workspace.id)
  }

  async function applyChanges() {
    if (!changes?.length || pending || !data) return
    setPending(true); setError(''); setNotice('')
    try {
      for (const change of changes) {
        const result = await updateWorkspaceMember({ workspaceId: data.workspace.id, ...change })
        if ('error' in result) { setError(translateError(result.error)); await refresh(); return }
      }
      setChanges(null)
      setNotice(t('memberUpdated'))
      await refresh()
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
      await refresh()
    } catch {
      setError(t('revokeFailed'))
    } finally { setPending(false) }
  }

  /** The member list as CSV, the columns MembersSettings exports. */
  function csv() {
    if (!data) return ''
    const role = (value: string) => value === 'admin' ? t('role.admin') : t('role.member')
    return memberCsv([
      [t('csv.name'), t('csv.email'), t('csv.role'), t('csv.status'), t('csv.joined')],
      ...data.members.map(member => [member.name, member.email, role(member.role), member.status === 'active' ? t('status.active') : t('status.suspended'), member.createdAt]),
      ...(canManage ? data.invitations.map(invite => ['', invite.email, role(invite.role), t('status.invited'), invite.expiresAt]) : []),
    ])
  }

  return {
    data, ready: Boolean(data), fetchError, retry: () => void mutate(), canManage,
    pending, error, notice, clearMessages: () => { setError(''); setNotice('') },
    /** Ask before a role change or suspension; nothing is saved until it is confirmed. */
    confirm: (list: MemberChange[]) => { setError(''); setChanges(list.length ? list : null) },
    revoke, csv,
    invite: () => setInviteOpen(true),
    dialogs: { inviteOpen, setInviteOpen, changes, setChanges, applyChanges, refresh },
  }
}

export type WorkspaceMembers = ReturnType<typeof useWorkspaceMembers>

/** The invite dialog and the confirmation MembersSettings uses, for the same page drawn by a UI layer. */
export function WorkspaceMembersDialogs({ members }: { members: WorkspaceMembers }) {
  const t = useTranslations('Members')
  const commonT = useTranslations('Common')
  const { data, canManage, pending, error, dialogs } = members
  const changes = dialogs.changes
  const first = changes?.[0]
  const name = (change?: MemberChange) => change?.name || t('thisMember')
  const description = !first ? '' : changes!.length > 1
    ? (first.status === 'suspended' ? t('confirmSuspendMany', { count: changes!.length }) : t('confirmRoleMany', { count: changes!.length, role: first.role === 'admin' ? t('role.admin') : t('role.member') }))
    : first.status === 'suspended' ? t('confirmSuspend', { name: name(first) }) : t('confirmRole', { name: name(first), role: first.role === 'admin' ? t('role.admin') : t('role.member') })
  if (!data) return null
  return <>
    <InviteMembersDialog key={data.workspace.id} workspaceId={data.workspace.id} workspaceName={data.workspace.name} currentUser={data.currentUser}
      open={dialogs.inviteOpen && canManage} onOpenChange={dialogs.setInviteOpen} onCreated={dialogs.refresh} />
    <AlertDialog open={Boolean(changes)} onOpenChange={value => { if (!value && !pending) dialogs.setChanges(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <FieldError>{error}</FieldError>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{commonT('cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={event => { event.preventDefault(); void dialogs.applyChanges() }}>{pending ? t('updating') : t('confirmUpdate')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}

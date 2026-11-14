'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWR, { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import posthog from 'posthog-js'
import { changeTeamMember, deleteTeam, getTeamDeletionImpact, loadTeamDirectory, removeTeamGrouping, saveTeam } from '@/app/actions/teams'
import { fetchTeamDirectory, fetchTeamMembers, isSettingsAccessError, settingsReadOptions, teamDirectoryKey, teamMembersKey } from '@/lib/settings-data'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { memberCsv } from '@/lib/invitation-csv'
import { suggestTeamIdentifier } from '@/lib/team-identifier'
import { useActionError } from '@/lib/use-action-error'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import type { TeamDeletionImpact } from '@/lib/workspace-admin/teams'

export type TeamDirectoryData = Awaited<ReturnType<typeof loadTeamDirectory>>
export type DirectoryTeam = TeamDirectoryData['teams'][number]
export type TeamPage = 'general' | 'members'
type TeamRemovalIntent = 'delete' | 'ungroup'

/**
 * 设置 › 团队 as data, for a UI layer that draws the page itself (slot `settings-members`): the
 * same read, address (`&team=`, `&view=general|members`, `&create=1`), join / leave, CSV export
 * and saves as TeamDirectory, plus 删除团队 (workspace admins; the name typed to confirm, with
 * how many tasks and projects go with it).
 */
export function useTeamDirectory(workspaceId?: string) {
  const t = useTranslations()
  const translateError = useActionError()
  const router = useRouter()
  const params = useSearchParams()
  const { mutate: refresh } = useSWRConfig()
  const { data, error: readError, mutate } = useSWR<TeamDirectoryData>(teamDirectoryKey(workspaceId), fetchTeamDirectory, settingsReadOptions)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deletion, setDeletion] = useState<{ intent: TeamRemovalIntent; team: DirectoryTeam; impact: TeamDeletionImpact | null } | null>(null)
  const impactRead = useRef(0)
  const isRemoving = useRef(false)
  const teamId = params.get('team') ?? undefined
  const view = params.get('view')
  const directoryHref = `/settings/teams?workspace=${encodeURIComponent(data?.workspace.id ?? workspaceId ?? '')}`
  const teamHref = (id: string, page?: TeamPage) => `${directoryHref}&team=${encodeURIComponent(id)}${page ? `&view=${page}` : ''}`

  function navigate(href: string) { if (!pushSettingsHistory(href, workspaceId)) router.push(href) }
  function updated() { void mutate(); void refresh('teams') }

  async function saved(id: string) {
    try {
      const directory = await loadTeamDirectory(workspaceId)
      await mutate(directory, { revalidate: false })
      void refresh('teams')
      navigate(teamHref(id))
    } catch { setError(t('FeatureCopy.c_9ae338b8')) }
  }

  /** Join a team or leave it (yourself); leaving from its page goes back to the list. */
  async function membership(id: string, joined: boolean, back = false) {
    if (pending) return false
    setPending(true); setError(''); setNotice('')
    try {
      const result = await changeTeamMember({ teamId: id, action: joined ? 'leave' : 'join' })
      if (!result.ok) { setError(result.error); return false }
      updated()
      if (back) navigate(directoryHref)
      return true
    } catch { setError(t('IssueDetail.operationFailed')); return false }
    finally { setPending(false) }
  }

  async function inspectRemoval(team: DirectoryTeam, intent: TeamRemovalIntent) {
    if (isRemoving.current) return
    const read = ++impactRead.current
    setError(''); setNotice('')
    setDeletion({ team, intent, impact: null })
    try {
      const result = await getTeamDeletionImpact(team.id)
      if (impactRead.current !== read) return
      if (result.error) { setDeletion(null); setError(translateError(result.error)); return }
      setDeletion({ team, intent, impact: result })
    } catch {
      if (impactRead.current !== read) return
      setDeletion(null); setError(t('IssueDetail.operationFailed'))
    }
  }

  function cancelDelete() {
    if (isRemoving.current) return
    impactRead.current++
    setDeletion(null); setError('')
  }

  async function submitRemoval(intent: TeamRemovalIntent, confirmName: string) {
    if (!deletion?.impact || deletion.intent !== intent || isRemoving.current
      || deletion.team.workspaceId !== data?.workspace.id || confirmName.trim() !== deletion.team.name
      || (intent === 'delete' && !deletion.impact.canDelete)) return
    isRemoving.current = true
    setPending(true); setError('')
    try {
      const command = intent === 'delete' ? deleteTeam : removeTeamGrouping
      const result = await command(deletion.team.id, confirmName)
      if (result.error) { setError(translateError(result.error)); return }
      setNotice(t(intent === 'delete' ? 'HostedMembers.teamDeleted' : 'HostedMembers.teamUngrouped', { name: deletion.team.name }))
      setDeletion(null)
      updated()
      if (teamId === deletion.team.id) navigate(directoryHref)
    } catch { setError(t('IssueDetail.operationFailed')) }
    finally { isRemoving.current = false; setPending(false) }
  }

  /** The given teams as teams.csv, the columns TeamDirectory exports. */
  function exportCsv(teams: DirectoryTeam[], link: HTMLAnchorElement | null) {
    const csv = memberCsv([[t('Settings.workspaceForm.name'), t('FeatureCopy.c_f60daeb5'), t('FeatureCopy.c_5ea2e0cd'), t('FeatureCopy.c_747b74ce'), t('Invite.roles.member'), t('FeatureCopy.c_243d2318')],
      ...teams.map(team => [team.name, team.identifier, team.description, t('Settings.groups.workspace'), String(team.memberCount), team.role === 'owner' ? t('Projects.fields.lead') : team.role === 'member' ? t('Invite.roles.member') : t('FeatureCopy.c_8dabc5fb')])])
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    // The page renders the link (lint-ui: no hand-built elements); without one there is nothing to click.
    if (!link) { URL.revokeObjectURL(url); return }
    link.href = url
    link.download = 'teams.csv'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const selected = data?.teams.find(team => team.id === teamId)
  return {
    data, loading: !data && !readError, readError, accessError: isSettingsAccessError(readError), retry: () => void mutate(),
    admin: data?.role === 'admin',
    pending, error, notice, clearMessages: () => { setError(''); setNotice('') }, clearNotice: () => setNotice(''),
    /** What the address asks for: the list, a new team, or one team's page (overview, 常规 or 成员). */
    route: { creating: params.get('create') === '1', teamId, team: selected, page: view === 'general' || view === 'members' ? view as TeamPage : undefined },
    navigate, directoryHref, teamHref,
    openList: () => navigate(directoryHref),
    openTeam: (id: string, page?: TeamPage) => navigate(teamHref(id, page)),
    openCreate: () => navigate(`${directoryHref}&create=1`),
    /** The team's own page in the workspace (团队概览). */
    openOverview: (id: string) => navigate(workspaceLink({ section: 'team-home', team: id })),
    saved, updated, membership,
    deletion, cancelDelete,
    askDelete: (team: DirectoryTeam) => inspectRemoval(team, 'delete'),
    askRemoveGrouping: (team: DirectoryTeam) => inspectRemoval(team, 'ungroup'),
    confirmDelete: (name: string) => submitRemoval('delete', name),
    confirmRemoveGrouping: (name: string) => submitRemoval('ungroup', name),
    exportCsv,
  }
}

export type TeamDirectoryState = ReturnType<typeof useTeamDirectory>

type EditableTeam = { id: string; name: string; identifier: string; description: string }

/** 创建团队 and a team's 常规: name, identifier (suggested from the name until typed) and description, as TeamForm. */
export function useTeamForm({ workspaceId, team, existingIdentifiers = [], editable = true, onSaved }: { workspaceId: string; team?: EditableTeam; existingIdentifiers?: readonly string[]; editable?: boolean; onSaved: (teamId: string) => void }) {
  const t = useTranslations()
  const [name, setNameValue] = useState(team?.name ?? '')
  const [identifier, setIdentifierValue] = useState(team?.identifier ?? '')
  const [identifierEdited, setIdentifierEdited] = useState(!!team)
  const [description, setDescription] = useState(team?.description ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const dirty = name !== (team?.name ?? '') || identifier !== (team?.identifier ?? '') || description !== (team?.description ?? '')
  // Unsaved changes are asked about before the page or another link takes them away.
  useEffect(() => {
    if (!dirty && !pending) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    const beforeNavigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null
      if (!(link instanceof HTMLAnchorElement) || link.href === window.location.href || link.target === '_blank' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (busy.current || !window.confirm(t('FeatureCopy.c_39f8d12d'))) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('click', beforeNavigate, true)
    return () => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('click', beforeNavigate, true) }
  }, [dirty, pending, t])
  function setName(value: string) {
    setNameValue(value)
    if (!team && !identifierEdited) setIdentifierValue(suggestTeamIdentifier(value, existingIdentifiers))
  }
  function setIdentifier(raw: string) {
    const value = raw.toUpperCase()
    setIdentifierEdited(!!value)
    setIdentifierValue(value || (!team ? suggestTeamIdentifier(name, existingIdentifiers) : ''))
  }
  /** Leave the form: asks first when something is not saved. */
  function leave(close: () => void) { if (!busy.current && (!dirty || window.confirm(t('FeatureCopy.c_39f8d12d')))) close() }
  async function submit() {
    if (busy.current || !editable) return
    busy.current = true; setPending(true); setError('')
    try {
      const result = await saveTeam({ id: team?.id, workspaceId, name, identifier, description })
      if (!result.ok) { setError(result.error); return }
      posthog.capture(team ? 'mikka_team_updated' : 'mikka_team_created')
      onSaved(result.data.id)
    } catch { setError(t('FeatureCopy.c_85f5c4d3')) }
    finally { busy.current = false; setPending(false) }
  }
  const canSubmit = editable && !pending && !!name.trim() && !!identifier.trim() && (!team || dirty)
  return { name, setName, identifier, setIdentifier, identifierValid: /^[A-Z][A-Z0-9]{1,11}$/.test(identifier), description, setDescription, pending, error, dirty, editable, canSubmit, submit, leave }
}

/** A team's 成员: who is in it, 设为负责人 / 设为成员, 移出 (asked first) and 添加工作区成员, as TeamMembersSettings. */
export function useTeamMembers(teamId: string, onUpdated: () => void) {
  const t = useTranslations()
  const { data, error: readError, mutate } = useSWR(teamMembersKey(teamId), fetchTeamMembers, settingsReadOptions)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  async function change(userId: string, action: 'add' | 'remove' | 'owner' | 'member') {
    if (pending) return
    setPending(true); setError('')
    try {
      const result = await changeTeamMember({ teamId, userId, action })
      if (!result.ok) { setError(result.error); return }
      setRemoving(null)
      await mutate(); onUpdated()
    } catch { setError(t('IssueDetail.operationFailed')) }
    finally { setPending(false) }
  }
  const memberIds = new Set(data?.members.map(member => member.userId))
  return {
    data, loading: !data && !readError, readError, retry: () => void mutate(), canManage: data?.canManage ?? false,
    members: data?.members ?? [],
    /** Active workspace members not yet in the team. */
    available: data?.workspaceMembers.filter(member => !memberIds.has(member.userId)) ?? [],
    pending, error,
    add: (userId: string) => change(userId, 'add'),
    setRole: (userId: string, role: 'owner' | 'member') => change(userId, role),
    /** 移出 is asked first: `askRemove`, then `confirmRemove`. */
    removing, askRemove: (userId: string) => { setError(''); setRemoving(userId) }, cancelRemove: () => { if (!pending) setRemoving(null) },
    confirmRemove: () => removing ? change(removing, 'remove') : Promise.resolve(),
  }
}

export type TeamMembersState = ReturnType<typeof useTeamMembers>

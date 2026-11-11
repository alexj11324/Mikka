'use client'

import { useRef, useState } from 'react'
import useSWR from 'swr'
import { deleteWorkspace, listArchivedBots, takeOverArchivedBot, transferWorkspace, updateWorkspace, type getWorkspaceDeletionImpact, type getWorkspaceGeneral, type getWorkspaceTransferTargets } from '@/app/actions/workspace-settings'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { withBasePath } from '@/lib/base-path'
import { publicAppOrigin } from '@/lib/platform/public-origin'
import { useActionError } from '@/lib/use-action-error'

// 常规 (V10): the workspace's icon, name and address, transferring and deleting
// it, and the archived bots an admin can take over. Shared by the open-source
// page and the hosted layer (docs/ui-overlay.md).

export const WORKSPACE_ICON_MAX_BYTES = 200 * 1024
export const WORKSPACE_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

type Field = 'name' | 'slug' | 'icon'
export interface WorkspaceFailedSave { field: Field; value: string | null; message: string }

function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('read failed'))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** The workspace's general settings, with drafts that save on blur or Enter, one save at a time. */
export function useWorkspaceGeneral(workspaceId: string | undefined) {
  const actionError = useActionError()
  const general = useSWR(settingsKeys.workspaceGeneral(workspaceId ?? ''), () => settingsRead<Awaited<ReturnType<typeof getWorkspaceGeneral>>>('workspace-general', { workspace: workspaceId }))
  const data = general.data && !general.data.error ? general.data : null
  const [name, setName] = useState<string | null>(null)
  const [slug, setSlug] = useState<string | null>(null)
  const [saving, setSaving] = useState<Field | null>(null)
  const [failed, setFailed] = useState<WorkspaceFailedSave | null>(null)
  // One save at a time: Enter followed by the blur from disabling the field must not send it twice.
  const inFlight = useRef(false)
  // A save asked for while another runs goes next; dropping it would leave a draft that looks saved.
  const queued = useRef<{ field: Field; value: string | null } | null>(null)
  const host = typeof window === 'undefined' ? '' : `${new URL(publicAppOrigin()).host}${withBasePath('/w/')}`

  function clearDraft(field: Field) {
    if (field === 'name') setName(null)
    if (field === 'slug') setSlug(null)
  }

  async function save(field: Field, value: string | null) {
    const current = data
    if (!current) return
    if (inFlight.current) { queued.current = { field, value }; return }
    inFlight.current = true
    setSaving(field)
    setFailed(null)
    try {
      const result = await updateWorkspace({ [field]: value }, current.id)
      // S-O: the shown value goes back to the saved one; 重试 sends the same change again.
      if (result.error) { setFailed({ field, value, message: actionError(result.error) }); return }
      await general.mutate({ ...current, ...result }, { revalidate: false })
    } catch {
      setFailed({ field, value, message: actionError() })
    } finally {
      clearDraft(field)
      setSaving(null)
      inFlight.current = false
      const next = queued.current
      queued.current = null
      if (next) void save(next.field, next.value)
    }
  }

  function commit(field: 'name' | 'slug') {
    if (!data) return
    const draft = field === 'name' ? name : slug
    if (draft === null) return
    const value = field === 'slug' ? draft.trim().toLowerCase() : draft.trim()
    const saved = field === 'name' ? data.name : data.slug ?? ''
    if (!value || value === saved) { clearDraft(field); return }
    void save(field, value)
  }

  /** Checks type and size, then saves the picture as a data URL. */
  async function pickIcon(file: File | undefined) {
    if (!file) return
    if (!WORKSPACE_ICON_TYPES.includes(file.type) || file.size > WORKSPACE_ICON_MAX_BYTES) { setFailed({ field: 'icon', value: null, message: actionError('workspaceIconInvalid') }); return }
    try { await save('icon', await readDataUrl(file)) } catch { setFailed({ field: 'icon', value: null, message: actionError('workspaceIconInvalid') }) }
  }

  return {
    loading: !general.data && !general.error,
    data,
    loadError: data ? null : actionError(general.data?.error),
    reload: () => { void general.mutate() },
    host, name, setName, slug, setSlug, saving, failed, save, commit, pickIcon,
    removeIcon: () => { void save('icon', null) },
    /** True when the failure was a picked icon, which 重试 picks again */
    failedPick: failed?.field === 'icon' && failed.value === null,
    retry: () => { if (failed) void save(failed.field, failed.value) },
  }
}

/** 转让工作区: the active members it can go to, and the transfer. */
export function useTransferWorkspace(workspaceId: string) {
  const actionError = useActionError()
  const targets = useSWR(settingsKeys.transferTargets(workspaceId), () => settingsRead<Awaited<ReturnType<typeof getWorkspaceTransferTargets>>>('transfer-targets', { workspace: workspaceId }))
  const people = targets.data && !targets.data.error ? targets.data : null
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** The new owner's name or email once transferred, or null */
  async function transfer(to: string): Promise<string | null> {
    setPending(true)
    setError(null)
    try {
      const result = await transferWorkspace(to, workspaceId)
      if (result.error) { setError(actionError(result.error)); setPending(false); return null }
      return result.owner.name || result.owner.email
    } catch {
      setError(actionError())
      setPending(false)
      return null
    }
  }

  return { people, readError: targets.error || targets.data?.error ? actionError(targets.data?.error) : null,
    reload: () => targets.mutate(), pending, error, transfer }
}

/** S-I: what deleting the workspace takes with it, and the delete once its name is typed. */
export function useDeleteWorkspace(workspaceId: string) {
  const actionError = useActionError()
  const impact = useSWR(settingsKeys.deletionImpact(workspaceId), () => settingsRead<Awaited<ReturnType<typeof getWorkspaceDeletionImpact>>>('deletion-impact', { workspace: workspaceId }))
  const counts = impact.data && !impact.data.error ? impact.data : null
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove(typed: string) {
    setPending(true)
    setError(null)
    try {
      const result = await deleteWorkspace(workspaceId, typed)
      if (result.error) { setError(actionError(result.error)); setPending(false); return }
      window.location.assign(withBasePath('/'))
    } catch {
      setError(actionError())
      setPending(false)
    }
  }

  return { counts, readError: impact.error || impact.data?.error ? actionError(impact.data?.error) : null,
    reload: () => impact.mutate(), pending, error, remove }
}

/**
 * Bots of people who left the team or were suspended stay paused until an admin
 * takes one over; it then runs on that admin's own resources (§8.3).
 */
export function useArchivedBots(workspaceId: string) {
  const actionError = useActionError()
  const list = useSWR(settingsKeys.archivedBots(workspaceId), () => listArchivedBots(workspaceId))
  const [pending, setPending] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ botId: string; message: string } | null>(null)
  const bots = list.data && !list.data.error ? list.data.bots : []
  // Members intentionally have no archived-bot section; other failures are not an empty list.
  const denied = list.data?.error === 'workspaceAccessDenied'
  const readError = !denied && (list.error || list.data?.error) ? actionError(list.data?.error) : null

  async function takeOver(botId: string) {
    setPending(botId)
    setFailed(null)
    try {
      const result = await takeOverArchivedBot(botId, workspaceId)
      if (result.error) { setFailed({ botId, message: actionError(result.error) }); return }
      await list.mutate()
    } catch {
      setFailed({ botId, message: actionError() })
    } finally {
      setPending(null)
    }
  }

  return { bots, readError, reload: () => list.mutate(), pending, failed, takeOver }
}

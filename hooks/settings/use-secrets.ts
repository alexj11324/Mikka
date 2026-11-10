'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { createMySecret, deleteMySecret, importMySecrets, listMySecrets, replaceMySecret } from '@/app/actions/user-secrets'
import { createSecret, deleteSecret, importSecrets, replaceSecret, type listSecrets } from '@/app/actions/workspace-secrets'
import { deleteSavedLogin, listSavedLoginUsage, replaceSavedLoginPassword, saveSavedLogin, type listSavedLogins } from '@/app/actions/settings-activity'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { parseDotenv, DOTENV_MAX_BYTES, type DotenvEntry, type DotenvError } from '@/lib/secrets/dotenv'
import { isReservedEnvName } from '@/lib/secrets/format'
import { memberMayWrite, type WorkspaceRole } from '@/lib/secrets/permissions'
import type { UserSecretView } from '@/lib/secrets/user-store'
import type { WorkspaceSecretView } from '@/lib/secrets/store'
import type { SavedLogin, SavedLoginUse } from '@/lib/settings/saved-logins'
import { useActionError } from '@/lib/use-action-error'

// 密钥与登录 / 密钥与环境 (decision 2026-11-02-2120): the person's own secrets,
// the workspace's secrets, and site logins. Values and passwords are write-only.
// Shared by the open-source page and the hosted layer (docs/ui-overlay.md); the
// pages keep only their markup.

export type SecretScope = 'workspace' | 'repository' | 'project' | 'thread'
export const SECRET_REPOSITORY = /^[^/\s]+\/[^/\s]+$/
export const secretScopeInput = (scope: SecretScope, reference: string) => scope === 'workspace' ? { type: 'workspace' as const }
  : scope === 'project' ? { type: 'project' as const, projectId: reference.trim() }
    : scope === 'thread' ? { type: 'thread' as const, threadId: reference.trim() }
      : { type: 'repository' as const, repository: reference.trim() }

/** The scopes this reader may write: admins pick; a member writes repository entries only. */
export function writableScopes(role: WorkspaceRole): SecretScope[] {
  return (['workspace', 'repository'] as const).filter(scopeType => role === 'admin' || memberMayWrite({ scopeType }))
}

export type DotenvPreview = { entries: DotenvEntry[]; errors: Array<DotenvError | { line: number; name: string; reason: 'reserved' }> } | { tooLarge: true }

/** The names a pasted .env would add, and its line problems; never its values. */
export function useDotenvPreview(text: string) {
  const preview = useMemo<DotenvPreview | null>(() => {
    if (!text.trim()) return null
    try {
      const parsed = parseDotenv(text)
      const reserved = parsed.entries.filter(entry => isReservedEnvName(entry.name)).map(entry => ({ line: entry.line, name: entry.name, reason: 'reserved' as const }))
      return { entries: parsed.entries.filter(entry => !isReservedEnvName(entry.name)), errors: [...parsed.errors, ...reserved].sort((a, b) => a.line - b.line) }
    } catch { return { tooLarge: true } }
  }, [text])
  return { preview, count: preview && !('tooLarge' in preview) ? preview.entries.length : 0 }
}

/** Reads a picked .env (≤ 2 MB) into the text; the error to show when it is too large. */
export function useDotenvFile(setText: (text: string) => void) {
  const actionError = useActionError()
  return (file: File | undefined): string | null => {
    if (!file) return null
    if (file.size > DOTENV_MAX_BYTES) return actionError('secretImportTooLarge')
    void file.text().then(setText)
    return null
  }
}

/** What a save or import closes with: a notice to show, or nothing. */
export type SecretSaved = { notice: string | null }

/* ---------- 我的密钥 ---------- */

export function useMySecrets(workspaceId: string) {
  const actionError = useActionError()
  const list = useSWR(['account:my-secrets', workspaceId], () => listMySecrets(workspaceId))
  return {
    secrets: list.data && !list.data.error ? list.data.secrets : null,
    loading: !list.data && !list.error,
    error: list.error || list.data?.error ? actionError(list.data?.error) : null,
    reload: () => { void list.mutate() },
  }
}

/**
 * Add or edit one of the person's secrets. A name the workspace already has asks
 * once (`shadow`), then the personal value wins in this person's runs.
 */
export function useMySecretEditor(workspaceId: string, secret: UserSecretView | null, shortValueNotice: (name: string) => string) {
  const actionError = useActionError()
  const [pending, setPending] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shadow, setShadow] = useState(false)

  async function save(input: { name: string; value: string; note: string; masked: boolean }, overrideWorkspace = false): Promise<SecretSaved | null> {
    setShadow(false)
    setPending('save')
    setError(null)
    try {
      const result = secret
        ? await replaceMySecret({ id: secret.id, ...(input.value ? { value: input.value } : {}), ...(input.note.trim() !== secret.note ? { note: input.note.trim() } : {}) }, workspaceId)
        : await createMySecret({ name: input.name.trim(), kind: input.masked ? 'secret' : 'env', value: input.value, note: input.note.trim(), overrideWorkspace }, workspaceId)
      if (result.error === 'secretNameShadowsWorkspace') { setShadow(true); return null }
      if (result.error) { setError(actionError(result.error)); return null }
      return { notice: result.warning === 'shortValueNotMasked' ? shortValueNotice(result.name) : null }
    } catch {
      setError(actionError())
      return null
    } finally {
      setPending(null)
    }
  }

  async function remove(): Promise<boolean> {
    if (!secret) return false
    setPending('delete')
    setError(null)
    try {
      const result = await deleteMySecret({ id: secret.id }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return false }
      return true
    } catch {
      setError(actionError())
      return false
    } finally {
      setPending(null)
    }
  }

  return { pending, error, setError, shadow, cancelShadow: () => setShadow(false), save, remove }
}

export type ImportTotals = { created: number; replaced: number; kept: number }

/** Bulk add to 我的密钥: a second pass adds only the names the workspace already has, once confirmed. */
export function useMySecretImport(workspaceId: string) {
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shadowed, setShadowed] = useState<string[] | null>(null)
  const [done, setDone] = useState<ImportTotals>({ created: 0, replaced: 0, kept: 0 })

  /** The totals once everything is in, or null while a confirm or an error is open. */
  async function run(input: { text: string; masked: boolean; replace: boolean }, overrideWorkspace = false): Promise<ImportTotals | null> {
    setShadowed(null)
    setPending(true)
    setError(null)
    try {
      const result = await importMySecrets({ text: input.text, masked: input.masked, onConflict: overrideWorkspace || !input.replace ? 'skip' : 'replace', overrideWorkspace }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return null }
      const total = overrideWorkspace
        ? { created: done.created + result.created.length, replaced: done.replaced, kept: done.kept }
        : { created: result.created.length, replaced: result.replaced.length, kept: result.kept.length + result.errors.filter(problem => problem.reason !== 'shadowsWorkspace').length }
      const shadows = result.errors.filter(problem => problem.reason === 'shadowsWorkspace').map(problem => problem.name ?? '')
      if (shadows.length) { setDone(total); setShadowed(shadows); return null }
      return total
    } catch {
      setError(actionError())
      return null
    } finally {
      setPending(false)
    }
  }

  return { pending, error, setError, shadowed, cancelShadow: () => setShadowed(null), done, run }
}

/* ---------- 工作区密钥 ---------- */

export function useWorkspaceSecrets(workspaceId: string) {
  const actionError = useActionError()
  const list = useSWR(settingsKeys.secrets(workspaceId), () => settingsRead<Awaited<ReturnType<typeof listSecrets>>>('secrets', { workspace: workspaceId }))
  const ok = list.data && !list.data.error ? list.data : null
  return {
    secrets: ok ? ok.secrets : null,
    /** Offer only what this reader may do (lib/secrets/permissions.ts); the server checks again. */
    role: ok ? ok.role : null,
    loading: !list.data && !list.error,
    error: list.error || list.data?.error ? actionError(list.data?.error) : null,
    reload: () => { void list.mutate() },
  }
}

/** Add one workspace secret, or edit one: a new value, note or scope. Name and masking are fixed once saved. */
export function useWorkspaceSecretEditor(workspaceId: string, secret: WorkspaceSecretView | null, shortValueNotice: (name: string) => string) {
  const actionError = useActionError()
  const [pending, setPending] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function save(input: { name: string; value: string; note: string; masked: boolean; scope: SecretScope; repository: string; moved: boolean }): Promise<SecretSaved | null> {
    setPending('save')
    setError(null)
    try {
      const result = secret
        ? await replaceSecret({ id: secret.id, ...(input.value ? { value: input.value } : {}), ...(input.note.trim() !== secret.note ? { note: input.note.trim() } : {}), ...(input.moved ? { scope: secretScopeInput(input.scope, input.repository) } : {}) }, workspaceId)
        : await createSecret({ name: input.name.trim(), kind: input.masked ? 'secret' : 'env', value: input.value, note: input.note.trim(), scope: secretScopeInput(input.scope, input.repository) }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return null }
      return { notice: result.warning === 'shortValueNotMasked' ? shortValueNotice(result.name) : null }
    } catch {
      setError(actionError())
      return null
    } finally {
      setPending(null)
    }
  }

  async function remove(): Promise<boolean> {
    if (!secret) return false
    setPending('delete')
    setError(null)
    try {
      const result = await deleteSecret({ id: secret.id }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return false }
      return true
    } catch {
      setError(actionError())
      return false
    } finally {
      setPending(null)
    }
  }

  return { pending, error, setError, save, remove }
}

/** Bulk add to the workspace: one scope for every line. */
export function useWorkspaceSecretImport(workspaceId: string) {
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(input: { text: string; masked: boolean; replace: boolean; scope: SecretScope; repository: string }): Promise<ImportTotals | null> {
    setPending(true)
    setError(null)
    try {
      const result = await importSecrets({ text: input.text, masked: input.masked, scope: secretScopeInput(input.scope, input.repository), onConflict: input.replace ? 'replace' : 'skip' }, workspaceId)
      if (result.error) { setError(actionError(result.error)); return null }
      return { created: result.created.length, replaced: result.replaced.length, kept: result.kept.length + result.errors.length }
    } catch {
      setError(actionError())
      return null
    } finally {
      setPending(false)
    }
  }

  return { pending, error, setError, run }
}

/* ---------- 网站登录 ---------- */

export function useSavedLogins() {
  const actionError = useActionError()
  const { data, error, isLoading, mutate } = useSWR(settingsKeys.savedLogins(), () => settingsRead<Awaited<ReturnType<typeof listSavedLogins>>>('saved-logins'))
  const [deleteError, setDeleteError] = useState<string | null>(null)

  async function remove(login: SavedLogin) {
    setDeleteError(null)
    try {
      const result = await deleteSavedLogin(login.id)
      if (result.error) { setDeleteError(actionError(result.error)); return }
      void mutate()
    } catch {
      setDeleteError(actionError())
    }
  }

  return {
    logins: data && !('error' in data) ? data.logins : [],
    loading: isLoading,
    failed: Boolean(error),
    deleteError, clearDeleteError: () => setDeleteError(null), remove,
    reload: () => { void mutate() },
  }
}

/** Add a login, or a new password for one. Site and account of a saved login are fixed. */
export function useSavedLoginEditor(login: SavedLogin | null) {
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** True once saved. */
  async function save(input: { site: string; account: string; password: string }): Promise<boolean> {
    setPending(true)
    setError(null)
    try {
      const result = login ? await replaceSavedLoginPassword(login.id, input.password) : await saveSavedLogin({ site: input.site.trim(), account: input.account.trim(), password: input.password })
      if (result.error) { setError(actionError(result.error)); return false }
      return true
    } catch {
      setError(actionError())
      return false
    } finally {
      setPending(false)
    }
  }

  return { pending, error, setError, save }
}

/** Which bots used a saved login, and how it went. */
export function useSavedLoginUsage(id: string) {
  const { data, error, isLoading } = useSWR(['account:saved-login-usage', id], () => listSavedLoginUsage(id))
  const uses: SavedLoginUse[] = data && !('error' in data) ? data.uses : []
  return { uses, loading: isLoading, failed: Boolean(error) }
}

export const withoutScheme = (site: string): string => site.replace(/^https?:\/\//, '')

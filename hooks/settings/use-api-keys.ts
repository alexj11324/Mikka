'use client'

import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { createApiKey, deleteApiKey, refetchApiKeyModels, updateApiKeyAfterQuota, updateApiKeyShare, type getApiKeys } from '@/app/actions/model-api-keys'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { useActionError } from '@/lib/use-action-error'
import type { ApiKeyProtocol, ApiKeyProvider, ApiKeyView } from '@/lib/model-api-key-providers'

export type ApiKey = ApiKeyView & { shared: boolean }

/** What 添加 API Key sends: a preset takes its key only; a custom provider also its name, Base URL, protocol and optional models. */
export type NewApiKey =
  | { provider: Exclude<ApiKeyProvider, 'custom'>; apiKey: string }
  | { provider: 'custom'; name: string; baseUrl: string; protocol: ApiKeyProtocol; apiKey: string; models?: string[] }

export const apiKeysKey = settingsKeys.apiKeys
/** A GET, like the other settings reads: it never waits in front of a save in the server-action queue. */
export const readApiKeys = (workspaceId: string) => settingsRead<Awaited<ReturnType<typeof getApiKeys>>>('api-keys', { workspace: workspaceId })
// The same key as model-order-settings' modelOrderKey, written here so this hook does not import a UI module.
const modelOrderKey = settingsKeys.modelOrder

/**
 * The person's API keys and custom providers in 模型与订阅, and what can be done
 * with them. The open-source page and the hosted layer draw it each in their own
 * look (docs/ui-overlay.md); the data and the saves are these.
 */
export function useApiKeys(workspaceId: string) {
  const actionError = useActionError()
  const keys = useSWR(apiKeysKey(workspaceId), () => readApiKeys(workspaceId))
  // The workspace's own SWR cache (workspace-app.tsx), where 优先使用的模型 lives: a key change re-reads it.
  const { mutate } = useSWRConfig()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ message: string; retry: () => void } | null>(null)
  const data = keys.data && !keys.data.error ? keys.data : null
  const loadError = keys.data?.error ? actionError(keys.data.error) : null

  async function share(key: ApiKey, shared: boolean) {
    setPending(true); setFailed(null)
    try {
      const result = await updateApiKeyShare({ id: key.id, shared }, workspaceId)
      if (result.error) { setFailed({ message: actionError(result.error), retry: () => void share(key, shared) }); return }
      await keys.mutate(result, { revalidate: false })
    } catch { setFailed({ message: actionError(), retry: () => void share(key, shared) }) } finally { setPending(false) }
  }
  async function refetch(key: ApiKey) {
    setPending(true); setFailed(null)
    try {
      const result = await refetchApiKeyModels(key.id, workspaceId)
      if (result.error) { setFailed({ message: actionError(result.error), retry: () => void refetch(key) }); return }
      await keys.mutate(result, { revalidate: false })
      void mutate(modelOrderKey(workspaceId))
    } catch { setFailed({ message: actionError(), retry: () => void refetch(key) }) } finally { setPending(false) }
  }
  async function remove(key: ApiKey) {
    setPending(true); setFailed(null)
    try {
      const result = await deleteApiKey(key.id, workspaceId)
      if (result.error) { setFailed({ message: actionError(result.error), retry: () => void remove(key) }); return }
      await keys.mutate()
      void mutate(modelOrderKey(workspaceId))
    } catch { setFailed({ message: actionError(), retry: () => void remove(key) }) } finally { setPending(false) }
  }
  /** Verifies and saves a new key; the error to show, or null once it is saved and the lists are read again. */
  async function add(input: NewApiKey): Promise<string | null> {
    try {
      const result = await createApiKey(input, workspaceId)
      if (result.error) return actionError(result.error)
    } catch { return actionError() }
    await keys.mutate()
    void mutate(modelOrderKey(workspaceId))
    return null
  }
  /** 订阅额度用完后，自动改用 API Key; the error to show, or null once saved. */
  async function setAfterQuota(on: boolean): Promise<string | null> {
    try {
      const result = await updateApiKeyAfterQuota(on, workspaceId)
      if (result.error) return actionError(result.error)
      await keys.mutate(result, { revalidate: false })
      return null
    } catch { return actionError() }
  }

  return { data, loadError, pending, failed, share, refetch, remove, add, setAfterQuota }
}

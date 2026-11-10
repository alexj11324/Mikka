'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { z } from 'zod'
import { updateAppPolicy, type getAppPolicy } from '@/app/actions/app-policy'
import { updateSharePolicy, type getSharePolicy } from '@/app/actions/personal-policy'
import type { AppAccess, PolicyApp } from '@/lib/app-policy/apps'
import { withBasePath } from '@/lib/base-path'
import { computerPermissions, type ComputerPermission } from '@/lib/computer/permission'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { ReadResponseError } from '@/lib/swr/retry'
import { useActionError } from '@/lib/use-action-error'

// 设置 › 团队权限's reads and saves (N4): 电脑操作, sharing subscriptions and API
// keys with teammates, and the connected apps the workspace's bots may use.
// Admins change them; everyone else sees the values (`canEdit`).

const computerStateSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), permission: z.enum(computerPermissions), canEdit: z.boolean() }),
])
export type ComputerPolicyState = z.infer<typeof computerStateSchema>

const computerPolicyPath = (workspaceId: string) => withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/computer-policy`)
export const computerPolicyKey = settingsKeys.computerPolicy
export async function readComputerPolicy(workspaceId: string): Promise<ComputerPolicyState> {
  const response = await fetch(computerPolicyPath(workspaceId), { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new ReadResponseError(response.status)
  return computerStateSchema.parse(await response.json())
}

/** 电脑操作: `state` is null until read; `enabled: false` means this deployment has no cloud computer (no row). */
export function useComputerPolicy(workspaceId: string) {
  const policy = useSWR(computerPolicyKey(workspaceId), () => readComputerPolicy(workspaceId))
  const [pending, setPending] = useState(false)
  const [changeError, setChangeError] = useState(false)
  const refresh = async () => { await policy.mutate() }
  async function change(permission: ComputerPermission) {
    setPending(true); setChangeError(false)
    try {
      const response = await fetch(computerPolicyPath(workspaceId), { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permission }) })
      if (!response.ok) throw new ReadResponseError(response.status)
      await refresh()
    } catch { setChangeError(true); await refresh().catch(() => undefined) } finally { setPending(false) }
  }
  return { state: policy.data ?? null, error: changeError || Boolean(policy.error), pending, change }
}

/** 订阅与 API Key: whether members may share theirs with teammates; 允许 by default (decision 2026-11-01-2240). */
export function useSharePolicy(workspaceId: string) {
  const actionError = useActionError()
  const policy = useSWR(settingsKeys.sharePolicy(workspaceId), () => settingsRead<Awaited<ReturnType<typeof getSharePolicy>>>('share-policy', { workspace: workspaceId }))
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<{ access: AppAccess; message: string } | null>(null)
  const data = policy.data && !policy.data.error ? policy.data : null
  const access: AppAccess = data?.allowed === false ? 'deny' : 'allow'

  async function change(next: AppAccess) {
    setPending(true)
    setFailed(null)
    try {
      const result = await updateSharePolicy(next === 'allow', workspaceId)
      if (result.error) { setFailed({ access: next, message: actionError(result.error) }); return }
      await policy.mutate(result, { revalidate: false })
    } catch {
      setFailed({ access: next, message: actionError() })
    } finally {
      setPending(false)
    }
  }
  return {
    loading: !policy.data && !policy.error,
    data, access, canEdit: data?.canEdit === true,
    /** The read failed: the words to show. */
    error: !policy.data && !policy.error ? null : data ? null : actionError(policy.data?.error),
    pending, failed, change,
    retry: () => { if (failed) void change(failed.access) },
  }
}

/** 允许使用的应用: per connected app, whether the workspace's bots may use it. */
export function useAppPolicy(workspaceId: string) {
  const actionError = useActionError()
  const policy = useSWR(settingsKeys.appPolicy(workspaceId), () => settingsRead<Awaited<ReturnType<typeof getAppPolicy>>>('app-policy', { workspace: workspaceId }))
  const [pending, setPending] = useState<PolicyApp | null>(null)
  const [failed, setFailed] = useState<{ app: PolicyApp; access: AppAccess; message: string } | null>(null)
  const data = policy.data && !policy.data.error ? policy.data : null

  async function change(app: PolicyApp, access: AppAccess) {
    setPending(app)
    setFailed(null)
    try {
      const result = await updateAppPolicy({ app, access }, workspaceId)
      // S-O: the select keeps the saved value; 重试 sends the same change.
      if (result.error) { setFailed({ app, access, message: actionError(result.error) }); return }
      await policy.mutate(result, { revalidate: false })
    } catch {
      setFailed({ app, access, message: actionError() })
    } finally {
      setPending(null)
    }
  }
  return {
    loading: !policy.data && !policy.error,
    data, apps: data?.apps ?? [], canEdit: data?.canEdit === true,
    error: !policy.data && !policy.error ? null : data ? null : actionError(policy.data?.error),
    pending, failed, change,
    retry: () => { if (failed) void change(failed.app, failed.access) },
  }
}

export type ComputerPolicyControl = ReturnType<typeof useComputerPolicy>
export type SharePolicyControl = ReturnType<typeof useSharePolicy>
export type AppPolicyControl = ReturnType<typeof useAppPolicy>

import { useCallback, useState } from 'react'
import { api, saveWorkspace } from '@/lib/api'
import { useHome } from '@/lib/home'
import type { Settings, Workspace } from '@/lib/types'
import { switchWorkspace } from '@/lib/workspace-switch'
import { orderWorkspaces } from './workspace-order'
import { useWorkspaceOrder } from './use-workspace-order'

/**
 * The person's workspaces in their order on this device, the open one, and a switch to another. The switch saves the
 * pick, reads it back, and keeps the old workspace when the server did not take it (lib/workspace-switch.ts).
 */
export function useWorkspaces() {
  const home = useHome()
  const [order, setOrder] = useWorkspaceOrder()
  const [switching, setSwitching] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const current = home.data?.workspace ?? null
  const workspaces = orderWorkspaces(home.data?.workspaces ?? [], order)
  const pick = useCallback(async (target: Workspace) => {
    if (switching || target.id === current?.id) return true
    setSwitching(target.id)
    setProblem(null)
    const failed = await switchWorkspace(target, current?.id ?? null, {
      save: saveWorkspace,
      current: async () => (await api<Settings>('/api/mobile/settings')).workspace.id,
    })
    await home.reload()
    setSwitching(null)
    setProblem(failed)
    return !failed
  }, [current?.id, home, switching])
  return { workspaces, current, pick, switching, problem, setOrder }
}

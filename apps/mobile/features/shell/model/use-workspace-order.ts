import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { parseWorkspaceOrder } from './workspace-order'

const KEY = 'mikka_workspace_order'

const read = async () => Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) ?? null : SecureStore.getItemAsync(KEY)
const write = async (value: string) => { if (Platform.OS === 'web') globalThis.localStorage?.setItem(KEY, value); else await SecureStore.setItemAsync(KEY, value) }

/** The person's arrangement of their workspaces on this device (workspace-order.ts), and a way to change it. */
export function useWorkspaceOrder(): [string[], (ids: string[]) => void] {
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    let gone = false
    read().then(raw => { if (!gone) setIds(parseWorkspaceOrder(raw)) }, () => undefined)
    return () => { gone = true }
  }, [])
  const save = useCallback((next: string[]) => {
    setIds(next)
    void write(JSON.stringify(next)).catch(() => undefined)
  }, [])
  return [ids, save]
}

import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { parseWorkspaceOrder } from './workspace-order'
import { currentAccount } from '@/lib/config'
import { accountStorageKey } from '@/lib/server-store'

const read = async (key: string) => Platform.OS === 'web' ? globalThis.localStorage?.getItem(key) ?? null : SecureStore.getItemAsync(key)
const write = async (key: string, value: string) => { if (Platform.OS === 'web') globalThis.localStorage?.setItem(key, value); else await SecureStore.setItemAsync(key, value) }

/** The person's arrangement of their workspaces on this device (workspace-order.ts), and a way to change it. */
export function useWorkspaceOrder(): [string[], (ids: string[]) => void] {
  const key = accountStorageKey(currentAccount().id, 'workspace_order')
  const [ids, setIds] = useState<string[]>([])
  useEffect(() => {
    let gone = false
    read(key).then(raw => { if (!gone) setIds(parseWorkspaceOrder(raw)) }, () => undefined)
    return () => { gone = true }
  }, [key])
  const save = useCallback((next: string[]) => {
    setIds(next)
    void write(key, JSON.stringify(next)).catch(() => undefined)
  }, [key])
  return [ids, save]
}

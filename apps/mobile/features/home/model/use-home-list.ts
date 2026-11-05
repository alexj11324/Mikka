import { useCallback, useEffect, useState } from 'react'
import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import type { ChatOrder } from './chat-order'
import type { ReadMark } from './chat-read'
import { type HomeListSave, parseHomeList } from './home-list'

const KEY = 'mikka_home_list'
const EMPTY: HomeListSave = { order: null, collapsed: [], read: {} }

export { parseHomeList, type HomeListSave }

const readStore = async () => Platform.OS === 'web' ? globalThis.localStorage?.getItem(KEY) ?? null : SecureStore.getItemAsync(KEY)
const writeStore = async (value: string) => {
  if (Platform.OS === 'web') globalThis.localStorage?.setItem(KEY, value)
  else await SecureStore.setItemAsync(KEY, value)
}

/** The person's arrangement of the home list on this device, and ways to change it. */
export function useHomeList() {
  const [save, setSave] = useState<HomeListSave>(EMPTY)
  useEffect(() => {
    let gone = false
    readStore().then(raw => { if (!gone) setSave(parseHomeList(raw)) }, () => undefined)
    return () => { gone = true }
  }, [])
  const update = useCallback((change: (current: HomeListSave) => HomeListSave) => {
    setSave(current => {
      const next = change(current)
      void writeStore(JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])
  const toggleSection = useCallback((id: string) => {
    update(current => ({
      ...current,
      collapsed: current.collapsed.includes(id) ? current.collapsed.filter(item => item !== id) : [...current.collapsed, id],
    }))
  }, [update])
  const setOrder = useCallback((order: ChatOrder) => { update(current => ({ ...current, order })) }, [update])
  const setRead = useCallback((id: string, mark: ReadMark) => { update(current => ({ ...current, read: { ...current.read, [id]: mark } })) }, [update])
  return { save, toggleSection, setOrder, setRead }
}

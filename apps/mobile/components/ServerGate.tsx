import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { View } from 'react-native'
import { servers } from '@/lib/config'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { CardButton } from '@/components/cards'
import { colors } from '@/lib/theme'
import { serverCopy as copy } from '@/lib/server-copy'

/** Do not initialize a session against a default server while SecureStore loads. */
export function ServerGate({ children }: { children: (id: string) => ReactNode }) {
  const state = useSyncExternalStore(servers.subscribe, servers.snapshot, servers.snapshot)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setFailed(false)
    void servers.initialize().catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [attempt])
  if (state.ready) return children(state.active)
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: colors.page }}>
    {failed ? <><Text accessibilityRole="alert">{copy.readFailed}</Text><CardButton label={copy.retry} onPress={() => setAttempt(value => value + 1)} /></> : <Spinner size={22} />}
  </View>
}

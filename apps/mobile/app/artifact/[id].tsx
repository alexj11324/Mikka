import { mobileMessages } from '@/lib/messages'
import { ReadNotice } from '@/components/ReadNotice'
import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { Spinner } from '@/components/icons'
import { Markdown } from '@/components/Markdown'
import { NavBar, underBar } from '@/components/NavBar'
import { authHeaders, REQUEST_TIMEOUT_MS } from '@/lib/api'
import { apiCache } from '@/lib/api-cache'
import { API_URL } from '@/lib/config'
import { colors } from '@/lib/theme'

/** A Markdown document from a bot's 资料库, read in the app (an HTML one opens on the web, where it runs sandboxed). */
export default function ArtifactScreen() {
  const { id, v, title } = useLocalSearchParams<{ id: string; v: string; title?: string }>()
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    const context = apiCache.context(), controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    setText(null); setFailed(false)
    void (async () => {
      try {
        const response = await fetch(`${API_URL}/api/artifacts/${id}/versions/${v}/download`, { headers: await authHeaders(), credentials: 'include', signal: controller.signal })
        if (!response.ok) throw new Error(String(response.status))
        const body = await response.text()
        if (alive) apiCache.commit(context, () => setText(body))
      } catch {
        if (alive) apiCache.commit(context, () => setFailed(true))
      } finally { clearTimeout(timer) }
    })()
    return () => { alive = false; controller.abort(); clearTimeout(timer) }
  }, [id, v, attempt])
  return (
    <View style={styles.screen}>
      <NavBar title={title ?? ''} />
      <ScrollView {...underBar} contentContainerStyle={styles.body}>
        {text !== null ? <Markdown text={text} /> : failed ? <ReadNotice error label={mobileMessages.MobileCore.document} onRetry={() => setAttempt(current => current + 1)} /> : <View style={styles.center}><Spinner /></View>}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.page },
  body: { padding: 20, paddingBottom: 48 },
  center: { paddingTop: 80, alignItems: 'center' },
  note: { textAlign: 'center', color: colors.secondary, marginTop: 40, fontSize: 15 },
})

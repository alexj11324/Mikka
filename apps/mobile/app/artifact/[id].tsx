import { useEffect, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { Spinner } from '@/components/icons'
import { Markdown } from '@/components/Markdown'
import { NavBar, underBar } from '@/components/NavBar'
import { Text } from '@/components/Text'
import { authHeaders } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { colors } from '@/lib/theme'

/** A Markdown document from a bot's 资料库, read in the app (an HTML one opens on the web, where it runs sandboxed). */
export default function ArtifactScreen() {
  const { id, v, title } = useLocalSearchParams<{ id: string; v: string; title?: string }>()
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch(`${API_URL}/api/artifacts/${id}/versions/${v}/download`, { headers: await authHeaders() })
        if (!response.ok) throw new Error(String(response.status))
        const body = await response.text()
        if (alive) setText(body)
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => { alive = false }
  }, [id, v])
  return (
    <View style={styles.screen}>
      <NavBar title={title ?? ''} />
      <ScrollView {...underBar} contentContainerStyle={styles.body}>
        {text !== null ? <Markdown text={text} /> : failed ? <Text style={styles.note}>没能打开</Text> : <View style={styles.center}><Spinner /></View>}
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

import { useEffect, useMemo, useState } from 'react'
import { Image, Pressable, ScrollView, StyleSheet, View, type ImageURISource } from 'react-native'
import { useRouter } from 'expo-router'
import { ChevronRight, ClipboardList, FileText, Play } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { Segmented } from '@/components/Segmented'
import { underBar } from '@/components/NavBar'
import { ChatImageViewer, type ViewerRequest } from '@/features/chat/components/chat-image-viewer'
import { apiConnection, authHeaders } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { mobileMessages } from '@/lib/messages'
import { colors } from '@/lib/theme'
import { openOnWeb } from '@/lib/web'
import { pullRef } from '../model/task-properties'
import { shownGroups, type ThreadArtifact, type ThreadArtifacts, type ThreadSegment } from '../model/thread-artifacts'
import { PullLine } from './pull-line'

const { IssueThreads, FactoryAcceptance } = mobileMessages

/**
 * 线程 | Artifact at the top of a thread (Alex, 2026-11-15, after ChatGPT's 聊天 | 工作): the system's segmented
 * control, centred in the bar and floating over the conversation; Liquid Glass on iOS 26 (Segmented.ios.tsx).
 */
export function ThreadSegments({ value, onChange }: { value: ThreadSegment; onChange: (value: ThreadSegment) => void }) {
  return (
    <View style={styles.segments}>
      <Segmented options={[{ value: 'thread', label: IssueThreads.chatTab }, { value: 'artifacts', label: IssueThreads.artifactsTab }]} value={value} onChange={onChange} />
    </View>
  )
}

type Capture = Extract<ThreadArtifact, { group: 'captures' }>
type Document = Extract<ThreadArtifact, { group: 'plans' | 'reports' }>

/**
 * The Artifact segment: 方案, PR, 报告, 截图和录屏, each with its count (lib/thread-artifacts.ts). A plan or report
 * opens in the reader (an HTML one on the web, sandboxed); a PR opens GitHub; a screenshot opens the picture viewer;
 * a recording opens on the web, where it plays, when the server gave its place.
 */
export function ThreadArtifactsList({ data }: { data: ThreadArtifacts }) {
  const router = useRouter()
  const groups = shownGroups(data)
  const captures = useMemo(() => data.groups.captures.filter((item): item is Capture => item.group === 'captures'), [data])
  const images = useMemo(() => captures.filter(item => item.kind === 'image'), [captures])
  const headers = useAuthHeaders()
  const sources = useMemo<ImageURISource[]>(() => images.map(item => ({ uri: captureUrl(item.captureId), headers: headers ?? undefined })), [images, headers])
  const [viewer, setViewer] = useState<ViewerRequest | null>(null)
  const openDocument = (item: Document) => item.kind === 'html'
    ? void openOnWeb(`/api/artifacts/${item.artifactId}/versions/${item.version}/frame`)
    : router.push({ pathname: '/artifact/[id]', params: { id: item.artifactId, v: String(item.version), title: item.title } })
  const captureLabel = (item: Capture) => item.title?.trim() || FactoryAcceptance.kind[item.kind === 'image' ? 'screenshot' : 'video']
  return (
    <ScrollView {...underBar} contentContainerStyle={styles.body}>
      {groups.map(({ group, items }) => (
        <View key={group} style={styles.group}>
          <Text accessibilityRole="header" style={styles.heading}>{IssueThreads.artifacts[group]}<Text style={styles.count}>{'  ' + items.length}</Text></Text>
          {group === 'captures'
            ? <View style={styles.grid}>{captures.map(item => {
              const index = images.indexOf(item)
              const open = item.kind === 'image' ? () => setViewer({ index, origin: null, radius: 0 }) : item.webPath ? () => { void openOnWeb(item.webPath!) } : undefined
              return (
                <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={IssueThreads.artifacts.open.replace('{title}', captureLabel(item))} disabled={!open} onPress={open}
                  style={({ pressed }) => [styles.tile, pressed && { opacity: 0.6 }]}>
                  {item.kind === 'image' && headers ? <Image source={sources[index]} style={styles.thumb} resizeMode="cover" /> : null}
                  {item.kind === 'video' ? <View style={styles.play}><Play size={14} color={colors.ink} fill={colors.ink} /></View> : null}
                </Pressable>
              )
            })}</View>
            : items.map(item => item.group === 'pullRequests'
              ? <PullLine key={item.id} pull={{ url: item.url, ref: pullRef(item.url), title: item.title?.trim() || null, state: item.state ?? 'open' }} />
              : item.group === 'plans' || item.group === 'reports'
                ? <Pressable key={item.id} accessibilityRole="button" onPress={() => openDocument(item)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.5 }]}>
                  <View style={styles.mark}>{item.group === 'plans' ? <ClipboardList size={16} color={colors.secondary} strokeWidth={1.9} /> : <FileText size={16} color={colors.secondary} strokeWidth={1.9} />}</View>
                  <Text style={styles.rowText} numberOfLines={1}>{item.title || FactoryAcceptance.kind.report}</Text>
                  <Text style={styles.version}>v{item.version}</Text>
                  <ChevronRight size={16} color={colors.tertiary} strokeWidth={2.2} />
                </Pressable>
                : null)}
        </View>
      ))}
      {viewer && sources.length ? <ChatImageViewer images={sources} request={viewer} onClose={() => setViewer(null)} /> : null}
    </ScrollView>
  )
}

const captureUrl = (captureId: string) => `${API_URL}/api/captures/${captureId}`

/** The headers that sign a capture's picture request as the person (the session cookie on iOS; the web sends its own). */
function useAuthHeaders() {
  const [headers, setHeaders] = useState<Record<string, string> | null>(null)
  useEffect(() => {
    let live = true
    void authHeaders(apiConnection()).then(value => { if (live) setHeaders(value) }).catch(() => { if (live) setHeaders({}) })
    return () => { live = false }
  }, [])
  return headers
}

const styles = StyleSheet.create({
  segments: { width: 220 },
  body: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32, gap: 24 },
  group: { gap: 2 },
  heading: { fontSize: 13, fontWeight: '600', color: colors.secondary, marginBottom: 4 },
  count: { fontWeight: '400', color: colors.tertiary, fontVariant: ['tabular-nums'] },
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 16, alignItems: 'center' },
  rowText: { flex: 1, fontSize: 15, color: colors.text },
  version: { fontSize: 13, color: colors.secondary, fontVariant: ['tabular-nums'] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  tile: { width: '31%', aspectRatio: 16 / 9, borderRadius: 10, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  thumb: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  play: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
})

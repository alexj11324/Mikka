import { type ReactNode } from 'react'
import { Linking, Pressable, StyleSheet, View } from 'react-native'
import { CircleDot } from 'lucide-react-native'
import { StatusIcon, threadStatus } from '@/components/icons'
import { Text } from '@/components/Text'
import { runTitle, type CitationSource } from '@/lib/types'
import { colors, font } from '@/lib/theme'

/**
 * The Markdown the Coordinator and agents write, as the app shows it:
 * headings, lists, paragraphs, code blocks, **bold**, `code` and links.
 * `[[issue:<id>]]` and `[[run:<id>]]` become mention chips that open the
 * task or thread (R-41); `sources` names them.
 */
export function Markdown({ text, sources = {}, onOpen, color = colors.text }: {
  text: string
  sources?: Record<string, CitationSource>
  onOpen?: (source: CitationSource) => void
  color?: string
}) {
  const blocks = parseBlocks(text)
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading': return <Text selectable key={index} style={[styles.heading, { color }]}>{inline(block.text, sources, onOpen, color)}</Text>
          case 'code': return <View key={index} style={styles.codeBlock}><Text selectable style={styles.codeText}>{block.text}</Text></View>
          case 'list':
            return (
              <View key={index} style={{ gap: 4 }}>
                {block.items.map((item, i) => (
                  <View key={i} style={styles.listItem}>
                    <Text style={[styles.body, { color }]}>{block.ordered ? `${i + 1}.` : '•'}</Text>
                    <Text selectable style={[styles.body, { color, flex: 1 }]}>{inline(item, sources, onOpen, color)}</Text>
                  </View>
                ))}
              </View>
            )
          case 'paragraph': return <Text selectable key={index} style={[styles.body, { color }]}>{inline(block.text, sources, onOpen, color)}</Text>
        }
      })}
    </View>
  )
}

type Block =
  | { type: 'heading'; text: string }
  | { type: 'code'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string }

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const code: string[] = []
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i])
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) { blocks.push({ type: 'heading', text: heading[1] }); continue }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (item) {
      const last = blocks[blocks.length - 1]
      const ordered = Boolean(item[2])
      if (last?.type === 'list' && last.ordered === ordered) last.items.push(item[3])
      else blocks.push({ type: 'list', ordered, items: [item[3]] })
      continue
    }
    if (!line.trim()) continue
    const last = blocks[blocks.length - 1]
    // Lines with no blank line between them are one paragraph.
    if (last?.type === 'paragraph' && lines[i - 1]?.trim()) last.text += `\n${line}`
    else blocks.push({ type: 'paragraph', text: line })
  }
  return blocks
}

const INLINE = /\[\[(issue|run):([0-9a-f-]{36})\]\]|\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?。，；：！？])/gi

function inline(text: string, sources: Record<string, CitationSource>, onOpen: ((source: CitationSource) => void) | undefined, color: string): ReactNode[] {
  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    if (match[1]) {
      const source = sources[match[2].toLowerCase()]
      if (source) parts.push(<View key={key++} style={styles.mentionWrap}><MentionChip source={source} onPress={() => onOpen?.(source)} /></View>)
    } else if (match[3]) parts.push(<Text key={key++} style={{ fontWeight: '600', color }}>{match[3]}</Text>)
    else if (match[4]) parts.push(<Text key={key++} style={styles.code}>{match[4]}</Text>)
    else {
      const url = match[6] ?? match[7]
      parts.push(<Text key={key++} style={styles.link} onPress={() => void Linking.openURL(url)}>{match[5] ?? url}</Text>)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** A task or thread named inline: its icon and name; tapping opens it. */
export function MentionChip({ source, onPress }: { source: CitationSource; onPress?: () => void }) {
  const label = source.kind === 'issue' ? [source.identifier, source.title].filter(Boolean).join(' ') : runTitle(source)
  return (
    <Pressable accessibilityRole="link" onPress={onPress} style={styles.mention}>
      {source.kind === 'run' ? <StatusIcon status={threadStatus(source.status)} size={14} /> : <CircleDot size={14} color={colors.secondary} strokeWidth={2} />}
      <Text style={styles.mentionText} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 25 },
  heading: { fontSize: 17, lineHeight: 25, fontWeight: '700' },
  listItem: { flexDirection: 'row', gap: 8 },
  codeBlock: { backgroundColor: 'rgba(0,0,0,0.05)', borderRadius: 10, padding: 10 },
  codeText: { fontFamily: font === undefined ? 'Menlo' : 'ui-monospace, Menlo, monospace', fontSize: 13, lineHeight: 19 },
  code: { fontFamily: font === undefined ? 'Menlo' : 'ui-monospace, Menlo, monospace', fontSize: 14, backgroundColor: 'rgba(0,0,0,0.05)' },
  link: { color: colors.accent },
  mentionWrap: { transform: [{ translateY: 5 }] },
  mention: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.chip, borderRadius: 8, paddingHorizontal: 7, height: 26, marginHorizontal: 2, maxWidth: 240 },
  mentionText: { fontSize: 15, flexShrink: 1 },
})

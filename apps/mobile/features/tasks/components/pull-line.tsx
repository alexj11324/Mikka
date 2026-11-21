import { Linking, Pressable, StyleSheet, View } from 'react-native'
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react-native'
import { Text } from '@/components/Text'
import { mobileMessages } from '@/lib/messages'
import { colors } from '@/lib/theme'
import type { TaskPullLine } from '../model/task-properties'

/** Capy's PR marks: open green, merged purple, closed red, draft grey (lib/pull-request-appearance.ts). */
const PULL_MARK = {
  open: { Icon: GitPullRequest, color: colors.prOpen },
  draft: { Icon: GitPullRequestDraft, color: colors.tertiary },
  merged: { Icon: GitMerge, color: colors.merged },
  closed: { Icon: GitPullRequestClosed, color: colors.danger },
} as const

/** As Capy writes a pull request: the state's coloured mark, repo#n quiet, then the title, with no state word. Opens the PR. */
export function PullLine({ pull }: { pull: TaskPullLine }) {
  const { Icon, color } = PULL_MARK[pull.state] ?? PULL_MARK.open
  const state = mobileMessages.IssueDetail.work.states[pull.state]
  return <Pressable accessibilityRole="link" accessibilityLabel={[state, pull.ref, pull.title].filter(Boolean).join(' ')} onPress={() => { void Linking.openURL(pull.url) }}
    style={({ pressed }) => [styles.line, pressed && { opacity: 0.5 }]}>
    <View style={styles.lineMark}><Icon size={15} color={color} strokeWidth={1.9} /></View>
    <Text style={styles.lineText} numberOfLines={1}>
      {pull.ref ? <Text style={styles.lineQuiet}>{pull.title ? pull.ref + ' ' : pull.ref}</Text> : null}{pull.title ?? (pull.ref ? '' : pull.url)}
    </Text>
  </Pressable>
}

const styles = StyleSheet.create({
  line: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8 },
  lineMark: { width: 16, alignItems: 'center' },
  lineText: { flexShrink: 1, fontSize: 15, color: colors.text },
  lineQuiet: { color: colors.secondary, fontVariant: ['tabular-nums'] },
})

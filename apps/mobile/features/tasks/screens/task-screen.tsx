import { presentedFactoryEvents, taskFactoryProgress } from '../../../../../lib/task-factory-events'
import { mobileMessages } from '@/lib/messages'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter, type Href } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChartNoAxesColumn, ChevronRight, Circle, CircleUserRound, Flag, GitBranch, GitPullRequest, Link, ListTree, MessageSquare, MessagesSquare, Sparkles, UserRound } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
import { Segmented } from '@/components/Segmented'
import { TaskDescription } from '../components/task-description'
import { NavBar, underBar } from '@/components/NavBar'
import { useScrolledUnderBar } from '@/components/BarBackdrop'
import { ReadNotice } from '@/components/ReadNotice'
import { Text } from '@/components/Text'
import { GlassButton } from '@/components/GlassButton'
import { Row } from '@/components/settings'
import { useHome } from '@/lib/home'
import { taskLinkAttempt } from '@/lib/push-route'
import { readPushedTask } from '@/lib/task-push-app'
import { taskDetailLive } from '@/lib/live-keys'
import { readPresentedTask } from '../model/task-presentation-read'
import type { TaskDetail } from '@/lib/types'
import { useLiveApi } from '@/lib/useApi'
import { openOnWeb } from '@/lib/web'
import { agoWhen, shortWhen } from '@/lib/clock'
import { colors, LIST_INSET, SPACE } from '@/lib/theme'
import { AttemptIcon, BOARD_LABEL, PriorityIcon, priorityLabel, TaskStateIcon } from '../components/task-icons'
import { ATTEMPT_WORD, attemptState, rowState } from '../model/task-groups'
import { activityEntries, activityEntryId, filteredTaskActivity, nativeActivityLabel, nativeHistoryPieces, type TaskActivityFilter, type ActivityEntry } from '../model/task-conversation'
import { taskProperties, type TaskProperty } from '../model/task-properties'
import { PullLine } from '../components/pull-line'
import { AgentName } from '../components/agent-name'
import { ReviewSummaryRow } from '@/features/review/components/review-summary-row'
import { reviewHref } from '@/features/review/model/routes'


/** Where an attempt opens: the task's one conversation, scrolled to that attempt (2026-11-07). */
export const conversationHref = (taskId: string, attempt?: string, workspace?: string): Href => ({ pathname: '/task/[id]/conversation',
  params: { id: taskId, ...(attempt ? { attempt } : {}), ...(workspace ? { workspace } : {}) } })

/**
 * A task's detail as the web task page, after Capy's issue page (decisions/2026-11-14-2330, R-61–R-63): its code and
 * title, its properties in one column (status, priority, assignee, creator, pull requests, threads, relations), its
 * description, then 活动 oldest first, one event per line, each starting with who. There is no 工作 section and no
 * evidence list: what a thread produced is on its Artifact tab. A push about a waiting thread lands here with
 * `attempt` and opens it once. 「+ 评论」 floats at the foot.
 */
export function TaskScreen() {
  // `workspace`: a push opened it after confirming the task's workspace (lib/task-push.ts); it reads only there.
  const { id, attempt, workspace } = useLocalSearchParams<{ id: string; attempt?: string; workspace?: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const bar = useScrolledUnderBar()
  const home = useHome().data
  const read = useCallback((path: string) => workspace ? readPushedTask(id, workspace) : readPresentedTask(path), [id, workspace])
  const { data, error, loading, reload } = useLiveApi<TaskDetail>(workspace ? `/api/mobile/tasks/${id}?workspace=${workspace}` : `/api/mobile/tasks/${id}`,
    detail => taskDetailLive(id, detail?.live?.workspaceId, home?.live?.workspaceId, home?.workspace.id, detail?.task.factoryTaskId, detail?.live?.factoryActivityVersion, Array.isArray(detail?.work?.connections)), read)
  const task = data?.task
  const openTaskOnWeb = () => { if (task) void openOnWeb(`/?issue=${encodeURIComponent(task.id)}`) }
  // The task's own state: its current attempt's in 等待你 and 进行中, else its board status (2026-11-07-2230).
  const shown = task ? rowState(task) : null
  // 活动 runs oldest first, from the task's creation down (Alex 2026-11-07); the server sends it newest first.
  const receipts = presentedFactoryEvents(data?.factoryEvents, task?.factoryTaskId)
  const conversations = data?.work?.conversations
  const progress = new Map(taskFactoryProgress(receipts).flatMap(group => group.runId ? [[group.runId, group.current] as const] : []))
  // An Agent's change is said by the thread it worked in (activityLineParts); an untitled thread falls back there.
  const stretches = (conversations ?? []).flatMap(thread => thread.detail?.createdAt ? [{
    at: thread.detail.createdAt, runId: thread.id, agentId: thread.detail.agentId ?? null, linked: true, title: thread.detail.name,
  }] : [])
  const properties = data ? taskProperties(data) : []
  // Factory receipts only say a thread's stage here; evidence is on the thread's Artifact tab, not in 活动 (R-62).
  const activity = data ? activityEntries(
    conversations ? data.activity.filter(item => item.kind === 'created') : data.activity,
    data.timeline ?? [],
  ) : []

  // Only the authorized Task detail can match a link to one of its runs.
  const [filter, setFilter] = useState<TaskActivityFilter>('all')
  const [shownRows, setShownRows] = useState(50)
  const filtered = filteredTaskActivity(activity, filter)
  const visibleActivity = filtered.slice(-shownRows)
  const earlier = filtered.length - visibleActivity.length
  useEffect(() => { setFilter('all'); setShownRows(50) }, [id])
  const filterLabels = mobileMessages.IssueDetail.frame
  const target = !loading && !error ? taskLinkAttempt(id, attempt, data) : undefined
  const opened = useRef(false)
  useEffect(() => { opened.current = false }, [id, attempt])
  useEffect(() => {
    if (!target || opened.current) return
    opened.current = true
    router.push(conversationHref(id, target, workspace))
  }, [id, target, router, workspace])

  return (
    <View style={styles.screen}>
      <NavBar scrolled={bar.scrolled} />
      <ScrollView {...underBar} onScroll={bar.onScroll} scrollEventThrottle={16} contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 96 }]}>
        <ReadNotice error={error} hasData={Boolean(data)} label={mobileMessages.Nav.tasks} onRetry={reload} />
        {target === null && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.activityMeta}>{mobileMessages.AgentCopy.conversationNotFound}</Text>}
        {loading && !data ? <View style={styles.center}><Spinner /></View> : null}
        {task ? (
          <>
            {task.identifier ? <Text style={styles.key} selectable>{task.identifier}</Text> : null}
            <Text accessibilityRole="header" style={styles.title} selectable>{task.title}</Text>
            {/* A code task's first row is its review summary; one tap opens the review (R2a, decisions/2026-11-08-1230). */}
            {task.review ? <View style={styles.review}><ReviewSummaryRow short summary={task.review} onPress={() => router.push(reviewHref(task.id))} /></View> : null}
            <View style={styles.properties}>
              {properties.map(item => <Property key={item.id} item={item} task={task} shown={shown} progress={progress}
                onTask={taskId => router.push(`/task/${taskId}`)} onThread={runId => router.push(`/thread/${runId}`)} onChat={chatId => router.push(`/groups/${chatId}`)} />)}
            </View>
            <Row label={mobileMessages.MobileCore.taskPropertiesOnWeb} onPress={openTaskOnWeb} />
            {task.description ? <View style={styles.description}><TaskDescription key={task.id} body={task.description} /></View> : null}
            {activity.length ? <Text accessibilityRole="header" style={styles.section}>{mobileMessages.MobileCore.activity}</Text> : null}
            {activity.length && conversations ? <Segmented value={filter} onChange={value => { setFilter(value); setShownRows(50) }} options={[
              { value: 'all', label: filterLabels.filterAll }, { value: 'comments', label: filterLabels.filterComments }, { value: 'agents', label: filterLabels.filterAgents },
            ]} /> : null}
            {earlier > 0 ? <Row label={filterLabels.showEarlier.replace('{count}', String(Math.min(50, earlier)))} onPress={() => setShownRows(n => n + 50)} /> : null}
            {visibleActivity.map((item, index) => <ActivityRow key={activityEntryId(item)} item={item} first={index === 0} last={index === visibleActivity.length - 1}
              taskId={task.id} code={task.identifier} stretches={stretches}
              onOpen={item.kind === 'agent' ? () => router.push(conversationHref(task.id, item.run.attempts[0]!.runId, workspace)) : undefined} />)}
          </>
        ) : null}
      </ScrollView>
      {task ? (
        <View pointerEvents="box-none" style={[styles.commentWrap, { bottom: insets.bottom + 12 }]}>
          {/* Comments are written on the web for now: the app has no comment route yet (#1671). */}
          <GlassButton label={mobileMessages.MobileCore.comment} onPress={openTaskOnWeb} />
        </View>
      ) : null}
    </View>
  )
}

const PROPERTY_ICON = {
  parent: GitBranch, status: Circle, priority: ChartNoAxesColumn, assignee: UserRound, createdBy: CircleUserRound,
  pullRequests: GitPullRequest, threads: MessagesSquare, child: ListTree, blockedBy: Flag, blocks: Flag, duplicate: Link, related: Link,
} as const

function propertyLabel(id: TaskProperty['id'], count: number) {
  const { Metadata, Issue } = mobileMessages
  switch (id) {
    case 'status': return Issue.statusLabel
    case 'priority': return Issue.priorityLabel
    case 'assignee': return Metadata.property.assignee
    case 'createdBy': return Metadata.property.createdBy
    case 'pullRequests': return count > 1 ? Metadata.property.pullRequestMany : Metadata.property.pullRequestOne
    case 'threads': return count > 1 ? Metadata.property.threadMany : Metadata.property.threadOne
    case 'child': return Metadata.relations.subissues
    default: return Metadata.relations.groupLabel[id]
  }
}

type PropertyProps = {
  item: TaskProperty; task: TaskDetail['task']; shown: ReturnType<typeof rowState> | null; progress: ReadonlyMap<string, Parameters<typeof nativeActivityLabel>[0]>
  onTask: (id: string) => void; onThread: (id: string) => void; onChat: (id: string) => void
}

/** One property: its icon and label, then its value or, for pull requests, threads and relations, one line each. */
function Property({ item, task, shown, progress, onTask, onThread, onChat }: PropertyProps) {
  const count = 'pulls' in item ? item.pulls.length : 'threads' in item ? item.chats.length + item.threads.length : 'tasks' in item ? item.tasks.length : 1
  const Icon = PROPERTY_ICON[item.id]
  return (
    <View style={styles.property}>
      <View style={styles.propertyLabel}>
        <Icon size={15} color={colors.secondary} strokeWidth={1.9} />
        <Text style={styles.propertyLabelText} numberOfLines={1}>{propertyLabel(item.id, count)}</Text>
      </View>
      <View style={styles.propertyValue}>
        {item.id === 'status' ? <Line mark={<TaskStateIcon state={shown?.state ?? null} status={task.status} size={15} />} text={BOARD_LABEL[task.status] ?? task.status} />
          : item.id === 'priority' ? <Line mark={<PriorityIcon priority={task.priority} size={15} />} text={priorityLabel(task.priority)} />
          : item.id === 'assignee' ? item.owner
            ? <Line mark={item.owner.kind === 'member' ? <UserRound size={15} color={colors.secondary} strokeWidth={1.9} /> : <Sparkles size={15} color={colors.secondary} strokeWidth={1.9} />} text={item.owner.name} />
            : <Line mark={<UserRound size={15} color={colors.tertiary} strokeWidth={1.9} />} text={mobileMessages.Metadata.assignee.unassignedLabel} muted />
          : item.id === 'createdBy' ? <Line mark={<CircleUserRound size={15} color={colors.secondary} strokeWidth={1.9} />} text={item.name} />
          : 'pulls' in item ? item.pulls.map(pull => <PullLine key={pull.url} pull={pull} />)
          : 'threads' in item ? <>
            {item.chats.map(chat => <Line key={chat.id} mark={null} text={chat.title || mobileMessages.ConversationDirectory.untitled} onPress={() => onChat(chat.id)} />)}
            {item.threads.map(thread => {
              const gate = [thread.id, ...thread.detail.attemptIds ?? []].map(id => progress.get(id)).find(Boolean)
              const result = thread.stopping ? mobileMessages.IssueThreads.stopping : thread.state === 'replaced' ? mobileMessages.MobileCore.threadReplaced : ATTEMPT_WORD[thread.state]
              // Capy's thread line leads with the thread's coloured status mark, done or not.
              return <Line key={thread.id} mark={thread.state === 'replaced' ? <View style={styles.dot} /> : <AttemptIcon result={thread.state} size={15} />}
                text={thread.detail.name || mobileMessages.Workspace.activity.untitledThread} detail={gate ? nativeActivityLabel(gate) : result} onPress={() => onThread(thread.id)} />
            })}
          </>
          : 'tasks' in item ? item.tasks.map(row => <Line key={row.id} mark={null} quiet={row.identifier} text={row.title} onPress={() => onTask(row.id)} />) : null}
      </View>
    </View>
  )
}

/** A property's value line: its mark, a quiet code, the text and a quiet detail; it opens what it names when it can. */
function Line({ mark, quiet, text, detail, muted, onPress }: { mark: ReactNode; quiet?: string | null; text: string; detail?: string; muted?: boolean; onPress?: () => void }) {
  const body = <>
    <View style={styles.lineMark}>{mark}</View>
    <Text style={[styles.lineText, muted && { color: colors.tertiary }]} numberOfLines={1}>
      {quiet ? <Text style={styles.lineQuiet}>{quiet + ' '}</Text> : null}{text}
    </Text>
    {detail ? <Text style={styles.lineDetail} numberOfLines={1}>{detail}</Text> : null}
  </>
  if (!onPress) return <View style={styles.line}>{body}</View>
  return <Pressable accessibilityRole="link" onPress={onPress} style={({ pressed }) => [styles.line, pressed && { opacity: 0.5 }]}>{body}</Pressable>
}

/**
 * One line of 活动, as Capy's issue log (R-63): its icon, one sentence that starts with who, then · how long ago.
 * A person is their name; an Agent's change is said by the thread it worked in (a link, 「无标题线程」 when no one
 * thread matches); no actor is Mikka. A comment is its author and its words. Only an older server, with no thread
 * list, still sends an Agent's runs as one row (its result and date), which opens the task's conversation.
 */
function ActivityRow({ item, first, last, onOpen, taskId, code, stretches }: { item: ActivityEntry; first: boolean; last: boolean; onOpen?: () => void; taskId: string; code: string | null; stretches: Parameters<typeof nativeHistoryPieces>[2] }) {
  const router = useRouter()
  const latest = item.kind === 'agent' ? item.run.attempts.at(-1)! : null
  // Its own run's result, never the task's reason: a run that finished and opened a PR is 完成; only the task waits.
  const result = latest ? attemptState(latest) : null
  const pullRequest = item.kind === 'agent' ? [...item.run.attempts].reverse().find(attempt => attempt.pullRequest)?.pullRequest : null
  const comment = item.kind === 'comment' || item.kind === 'reply' ? item : null
  const at = item.kind === 'agent' ? null : 'at' in item ? item.at : item.createdAt
  const ago = at ? <Text style={styles.activityMeta}>{' · ' + agoWhen(at)}</Text> : null
  const event = item.kind === 'history' ? item.event : null
  const glyph = result ? <AttemptIcon result={result} size={20} />
    : event?.kind === 'status' && event.status ? <TaskStateIcon state={null} status={event.status} size={16} />
    : event?.kind === 'priority' && event.priority ? <PriorityIcon priority={event.priority} size={16} />
    : event?.kind === 'pull' ? <GitPullRequest size={16} color={colors.secondary} strokeWidth={1.9} />
    : comment ? <MessageSquare size={16} color={colors.secondary} strokeWidth={1.9} />
    : null
  const body = (
    <>
      {/* The timeline: each item draws the line through its own height (none above the first, none below the last), so
          it runs on unbroken whatever the items' heights. A line's node is its event's icon, else a small grey dot.
          The node's page fill hides the line. */}
      <View style={styles.rail}>
        {first ? null : <View style={[styles.rule, styles.lineAbove]} />}
        {last ? null : <View style={[styles.rule, styles.lineBelow]} />}
        {glyph ? <View style={styles.node}>{glyph}</View> : <View style={styles.dot} />}
      </View>
      <View style={styles.activityText}>
        {item.kind === 'agent' ? <>
          <AgentName harness={item.run.harness} style={styles.activityTitle} />
          <Text style={styles.activityMeta} numberOfLines={2}>
            {result && latest ? [ATTEMPT_WORD[result], result === 'done' && pullRequest ? mobileMessages.MobileCore.openedPullRequest.replace('{number}', String(pullRequest.number)) : null, shortWhen(latest.createdAt)].filter(Boolean).join(' · ') : null}
          </Text>
        </> : comment ? <>
          <Text style={styles.activitySentence} numberOfLines={1}><Text style={styles.activityName}>{comment.author}</Text>{ago}</Text>
          <Text style={styles.activityBody} numberOfLines={4}>{comment.body}</Text>
        </> : <Text style={styles.activitySentence} numberOfLines={3}>
          {event ? nativeHistoryPieces(event, { taskId, code }, stretches).map((piece, index) => {
            if (piece.kind === 'text') return piece.name ? <Text key={index} style={styles.activityName}>{piece.text}</Text> : piece.text
            return <Text key={index} accessibilityRole="link" style={styles.activityLink} onPress={() => {
              if (piece.kind === 'thread') router.push(`/thread/${piece.runId}`)
              else if (piece.kind === 'pull') void Linking.openURL(piece.href)
              else router.push(`/task/${piece.taskId}`)
            }}>{piece.text}</Text>
          }) : 'at' in item ? nativeActivityLabel(item, { taskId, code }) : item.kind === 'replaced' ? mobileMessages.MobileCore.threadReplaced : item.kind === 'created' && item.by ? mobileMessages.MobileCore.taskCreatedBy.replace('{name}', item.by) : mobileMessages.MobileCore.taskCreated}
          {ago}
        </Text>}
      </View>
      {onOpen ? <ChevronRight size={18} color={colors.tertiary} strokeWidth={2} /> : null}
    </>
  )
  return onOpen
    ? <Pressable accessibilityRole="link" onPress={onOpen} style={({ pressed }) => [styles.activity, pressed && { backgroundColor: colors.pressed }]}>{body}</Pressable>
    : <View style={styles.activity}>{body}</View>
}

const styles = StyleSheet.create({
  activityLink: { color: colors.text, textDecorationLine: 'underline' },
  screen: { flex: 1, backgroundColor: colors.page },
  body: { paddingHorizontal: LIST_INSET, paddingTop: 8, gap: 0 },
  center: { paddingTop: 40, alignItems: 'center' },
  key: { fontSize: 15, color: colors.secondary, fontVariant: ['tabular-nums'] },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', color: colors.text, marginTop: 4, marginBottom: SPACE.block },
  /** One column on the page, no box around it (Alex 2026-11-08: no grey slabs): label on the left, value on the right. */
  properties: { gap: 2, marginBottom: 4 },
  property: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  propertyLabel: { width: 112, minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8 },
  propertyLabelText: { flexShrink: 1, fontSize: 15, color: colors.secondary },
  propertyValue: { flex: 1, minWidth: 0 },
  line: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8 },
  lineMark: { width: 16, alignItems: 'center' },
  lineText: { flexShrink: 1, fontSize: 15, color: colors.text },
  lineQuiet: { color: colors.secondary, fontVariant: ['tabular-nums'] },
  lineDetail: { flexShrink: 0, maxWidth: '45%', marginLeft: 'auto', fontSize: 13, color: colors.secondary },
  description: { marginTop: SPACE.block },
  review: { marginTop: -SPACE.block / 2, marginBottom: SPACE.block / 2 },
  section: { marginTop: SPACE.block + 8, marginBottom: 4, fontSize: 14, fontWeight: '600', color: colors.secondary },
  activity: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58, marginHorizontal: -8, paddingHorizontal: 8, paddingVertical: SPACE.item / 2, borderRadius: 10, borderCurve: 'continuous' },
  /** Spans the item's full height, its padding included, so the line meets the next item's. */
  rail: { width: 24, alignSelf: 'stretch', marginVertical: -SPACE.item / 2, alignItems: 'center', justifyContent: 'center' },
  node: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.page },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.tertiary },
  rule: { position: 'absolute', width: 1.5, backgroundColor: colors.separator },
  lineAbove: { top: 0, bottom: '50%' },
  lineBelow: { top: '50%', bottom: 0 },
  activityText: { flex: 1, minWidth: 0, gap: 2 },
  activityTitle: { fontSize: 16, fontWeight: '500', color: colors.text },
  activitySentence: { fontSize: 15, lineHeight: 20, color: colors.text },
  activityName: { fontWeight: '600' },
  activityBody: { fontSize: 15, lineHeight: 20, color: colors.text },
  activityMeta: { fontSize: 13, color: colors.secondary },
  commentWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
})

import { useState } from 'react'
import { Platform, Pressable, StyleSheet, View } from 'react-native'
import { Check, ChevronDown, ChevronRight, Terminal, Wrench, X } from 'lucide-react-native'
import { Spinner } from '@/components/icons'
import { Text } from '@/components/Text'
import { tap } from '@/lib/haptics'
import { mobileMessages } from '@/lib/messages'
import { colors } from '@/lib/theme'
import { ATTEMPT_WORD } from '../model/task-groups'
import { stepDuration, stepLine, stepsLabel, type ThreadStep } from '../model/thread-steps'

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })
/** Lines of a step's output before 显示更多. */
const OUTPUT_LINES = 8

/**
 * A run's folded tool calls in its conversation (Alex 2026-11-08, after Codex's 「已运行 4 条命令 · 调用了 9 个工具 ›」):
 * a row with what ran and a chevron; a tap lists each command (as typed) or tool (with the input that says what it
 * did), its state and, when the server sends it, how long it took. A step with output opens to it, cut to a few lines
 * with 显示更多. An older server sends only the count: the row reads 「执行了 3 步」 and does not open.
 */
export function ThreadSteps({ steps, count, live }: { steps?: ThreadStep[]; count: number; live: boolean }) {
  const [open, setOpen] = useState(false)
  const opens = Boolean(steps?.length)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <View>
      <Pressable accessibilityRole={opens ? 'button' : undefined} accessibilityState={opens ? { expanded: open } : undefined} disabled={!opens} hitSlop={6}
        onPress={() => { tap(); setOpen(value => !value) }} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
        {live ? <Spinner size={14} /> : <Check size={15} color={colors.secondary} strokeWidth={2.2} />}
        <Text style={styles.label}>{stepsLabel(steps, count)}</Text>
        {opens ? <Chevron size={15} color={colors.tertiary} strokeWidth={2.2} /> : null}
      </Pressable>
      {open && steps ? (
        <View style={styles.list}>
          {steps.map((step, index) => <Step key={step.id} step={step} running={live && index === steps.length - 1} />)}
        </View>
      ) : null}
    </View>
  )
}

function Step({ step, running }: { step: ThreadStep; running: boolean }) {
  const [shown, setShown] = useState(false)
  const [full, setFull] = useState(false)
  const line = stepLine(step)
  const duration = stepDuration(step.ms)
  const output = step.output?.trim() || null
  const Kind = line.code ? Terminal : Wrench
  const state = ATTEMPT_WORD[running ? 'running' : step.failed ? 'failed' : 'done']
  const body = (
    <>
      <Kind size={14} color={colors.secondary} strokeWidth={2} style={styles.kind} />
      <View style={styles.text}>
        <Text style={[styles.title, line.code && styles.code]} numberOfLines={2}>{line.title}</Text>
        {line.detail || duration ? <Text style={styles.detail} numberOfLines={1}>{[line.detail, duration].filter(Boolean).join(' · ')}</Text> : null}
      </View>
      {running ? <Spinner size={12} /> : step.failed ? <X size={14} color={colors.danger} strokeWidth={2.4} /> : <Check size={14} color={colors.secondary} strokeWidth={2.2} />}
    </>
  )
  return (
    <View>
      {output ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: shown }} accessibilityLabel={`${line.title} · ${state}`}
          onPress={() => { tap(); setShown(value => !value) }} style={({ pressed }) => [styles.step, pressed && { opacity: 0.6 }]}>{body}</Pressable>
      ) : (
        <View accessible accessibilityLabel={`${line.title} · ${state}`} style={styles.step}>{body}</View>
      )}
      {shown && output ? (
        <View style={styles.output}>
          <Text style={styles.outputText} numberOfLines={full ? undefined : OUTPUT_LINES} selectable>{output}</Text>
          {output.split('\n').length > OUTPUT_LINES || output.length > 600 ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => setFull(value => !value)}>
              <Text style={styles.more}>{full ? mobileMessages.MobileCore.threadSteps.showLess : mobileMessages.MobileCore.threadSteps.showMore}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32, alignSelf: 'flex-start' },
  label: { fontSize: 14, color: colors.secondary },
  list: { marginTop: 4, marginLeft: 6, paddingLeft: 14, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.separator, gap: 2 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 6, minHeight: 32 },
  kind: { marginTop: 2 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 14, lineHeight: 19, color: colors.text },
  code: { fontFamily: MONO, fontSize: 12.5 },
  detail: { fontSize: 12, color: colors.secondary },
  output: { marginLeft: 22, marginBottom: 6, gap: 4 },
  outputText: { fontFamily: MONO, fontSize: 12, lineHeight: 17, color: colors.secondary },
  more: { fontSize: 13, fontWeight: '600', color: colors.accent },
})

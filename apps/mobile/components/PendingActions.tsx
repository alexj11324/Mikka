import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { CalendarClock, Mail } from 'lucide-react-native'
import { CardButton, ChatCard, Field, cardText } from '@/components/cards'
import { Text } from '@/components/Text'
import { api, ApiError } from '@/lib/api'
import type { PendingAction } from '@/lib/types'
import { colors } from '@/lib/theme'

const TITLE: Record<string, string> = { send_email: '发送邮件', create_calendar_event: '新建日程', update_calendar_event: '修改日程' }

/** "2026-10-27T10:00:00-07:00" → "2026-10-27 10:00 -07:00", as the web's card shows it (components/coordinator/pending-actions.tsx). */
export function shownTime(value: unknown, timezone?: unknown) {
  if (typeof value !== 'string') return null
  const text = value.replace('T', ' ').replace(/(\d{2}:\d{2}):00(?=$|Z|[+-])/, '$1').replace(/(Z|[+-]\d{2}:\d{2})$/, ' $1')
  return typeof timezone === 'string' ? `${text} (${timezone})` : text
}

const list = (value: unknown) => Array.isArray(value) && value.length ? value.join(', ') : null
const text = (value: unknown) => typeof value === 'string' && value ? value : null

type Outcome = { item: PendingAction; line: string; failed?: boolean }

/**
 * What the person's agents want to do in their mail and calendar, one card
 * each, at the end of the chat as the web shows them above its composer.
 * Nothing runs until the person approves (Slack and GitHub Mobile actionable
 * cards). A push about one opens the chat with that card marked (`focus`).
 */
export function PendingActions({ items, focus, reload, onFocusLayout }: { items: PendingAction[]; focus?: string; reload: () => Promise<void>; onFocusLayout?: (y: number) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})

  const decide = async (item: PendingAction, approve: boolean) => {
    setBusy(item.id)
    setErrors(current => ({ ...current, [item.id]: '' }))
    try {
      const result = await api<{ status: 'done' | 'failed' | 'declined'; reason: string | null }>(`/api/mobile/pending-actions/${item.id}`, { method: 'POST', body: { approve } })
      if (result.status === 'done') setOutcomes(current => [...current, { item, line: item.action === 'send_email' ? '邮件已发送' : '日历已更新' }])
      else if (result.status === 'failed') setOutcomes(current => [...current, { item, line: `没做成：${result.reason ?? ''}`, failed: true }])
      await reload()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setOutcomes(current => [...current, { item, line: '已处理或已过期' }])
        await reload()
      } else setErrors(current => ({ ...current, [item.id]: '没发出去，再试一次。' }))
    } finally {
      setBusy(null)
    }
  }

  const shown = new Set(items.map(item => item.id))
  const missed = focus && !shown.has(focus) && !outcomes.some(outcome => outcome.item.id === focus)

  return (
    <View style={{ gap: 12 }} accessibilityLabel="等你确认">
      {outcomes.filter(outcome => !shown.has(outcome.item.id)).map(({ item, line, failed }) => (
        <ChatCard key={`done-${item.id}`}>
          <Heading item={item} />
          <Text style={failed ? cardText.error : cardText.meta}>{line}</Text>
        </ChatCard>
      ))}
      {missed ? <Text style={styles.missed} onLayout={event => onFocusLayout?.(event.nativeEvent.layout.y)}>这件事已处理或已过期。</Text> : null}
      {items.map(item => {
        const input = item.input
        const email = item.action === 'send_email'
        const body = text(email ? input.body : input.description)
        return (
          <View key={item.id} onLayout={item.id === focus ? event => onFocusLayout?.(event.nativeEvent.layout.y) : undefined}>
            <ChatCard highlighted={item.id === focus}>
              <Heading item={item} />
              <View style={{ gap: 4 }}>
                {email ? (
                  <>
                    <Field label="收件人">{list(input.to)}</Field>
                    <Field label="抄送">{list(input.cc)}</Field>
                    <Field label="密送">{list(input.bcc)}</Field>
                    <Field label="主题">{text(input.subject)}</Field>
                  </>
                ) : (
                  <>
                    {item.context ? <Field label="原日程">{[item.context.summary, [shownTime(item.context.start), shownTime(item.context.end)].filter(Boolean).join(' – ')].filter(Boolean).join(' · ')}</Field> : null}
                    <Field label="标题">{text(input.summary)}</Field>
                    <Field label="时间">{input.start || input.end ? [shownTime(input.start, input.timezone), shownTime(input.end)].filter(Boolean).join(' – ') : null}</Field>
                    <Field label="地点">{text(input.location)}</Field>
                    <Field label="参与者">{list(input.attendees)}</Field>
                    {list(input.attendees) ? <Field label="通知">{input.notify_attendees === false ? '不通知' : '给参与者发邮件'}</Field> : null}
                  </>
                )}
              </View>
              {body ? <View style={styles.body}><Text style={cardText.body} numberOfLines={12}>{body}</Text></View> : null}
              <View style={styles.actions}>
                <CardButton label="不要" disabled={busy !== null} onPress={() => void decide(item, false)} />
                <CardButton primary label={email ? '发送' : '保存到日历'} disabled={busy !== null && busy !== item.id} busy={busy === item.id} onPress={() => void decide(item, true)} />
              </View>
              {errors[item.id] ? <Text style={cardText.error}>{errors[item.id]}</Text> : null}
            </ChatCard>
          </View>
        )
      })}
    </View>
  )
}

function Heading({ item }: { item: PendingAction }) {
  const Icon = item.action === 'send_email' ? Mail : CalendarClock
  return (
    <View style={styles.heading}>
      <Icon size={18} color={colors.ink} strokeWidth={1.8} />
      <Text style={cardText.title}>{TITLE[item.action] ?? item.action}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  body: { backgroundColor: colors.bubble, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  missed: { alignSelf: 'center', fontSize: 13, color: colors.secondary },
})

import { useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { CalendarClock, Mail } from 'lucide-react-native'
import { CardButton, ChatCard, Field, cardText } from '@/components/cards'
import { Symbol } from '@/components/Symbol'
import { Text } from '@/components/Text'
import { api, ApiError } from '@/lib/api'
import { tap } from '@/lib/haptics'
import type { PendingAction } from '@/lib/types'
import { colors } from '@/lib/theme'
import { mobileMessages } from '@/lib/messages'

const A = mobileMessages.Coordinator.pendingActions
const M = mobileMessages.MobileCore
const TITLE: Record<string, string> = { send_email: A.send_email, create_calendar_event: A.create_calendar_event, update_calendar_event: A.update_calendar_event }

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
  const inFlight = useRef(false)
  const settled = useRef(new Set<string>())
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})

  const decide = async (item: PendingAction, approve: boolean) => {
    if (inFlight.current || settled.current.has(item.id)) return
    inFlight.current = true
    setBusy(item.id)
    setErrors(current => ({ ...current, [item.id]: '' }))
    const remember = (line: string, failed = false) => {
      settled.current.add(item.id)
      setOutcomes(current => [...current.filter(outcome => outcome.item.id !== item.id), { item, line, failed }])
    }
    // The read owns its error notice; a failed refresh cannot undo an acknowledged decision.
    const refresh = () => reload().catch(() => {})
    try {
      const result = await api<{ status: 'done' | 'failed' | 'declined'; reason: string | null }>(`/api/mobile/pending-actions/${item.id}`, { method: 'POST', body: { approve } })
      if (result.status !== 'failed') tap()
      if (result.status === 'done') remember(item.action === 'send_email' ? A.sent : A.saved)
      else if (result.status === 'failed') remember(mobileMessages.Coordinator.pendingActions.failed.replace('{error}', result.reason ?? ''), true)
      else remember(M.rejected)
      await refresh()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // The server's own words for a decision another device already took.
        remember(mobileMessages.Errors.pendingActionUnavailable)
        await refresh()
      } else setErrors(current => ({ ...current, [item.id]: M.sendFailedRetry }))
    } finally {
      inFlight.current = false
      setBusy(null)
    }
  }

  const completed = new Set(outcomes.map(outcome => outcome.item.id))
  const shown = new Set(items.map(item => item.id))
  const missed = focus && !shown.has(focus) && !outcomes.some(outcome => outcome.item.id === focus)

  return (
    <View style={{ gap: 12 }} accessibilityLabel={A.label}>
      {outcomes.map(({ item, line, failed }) => (
        <View key={`done-${item.id}`} onLayout={item.id === focus ? event => onFocusLayout?.(event.nativeEvent.layout.y) : undefined}>
          <ChatCard highlighted={item.id === focus}>
            <Heading item={item} />
            <Text accessibilityLiveRegion="polite" style={failed ? cardText.error : cardText.meta}>{line}</Text>
          </ChatCard>
        </View>
      ))}
      {missed ? <Text style={styles.missed} onLayout={event => onFocusLayout?.(event.nativeEvent.layout.y)}>{mobileMessages.Errors.pendingActionUnavailable}</Text> : null}
      {items.filter(item => !completed.has(item.id)).map(item => {
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
                    <Field label={A.to}>{list(input.to)}</Field>
                    <Field label={A.cc}>{list(input.cc)}</Field>
                    <Field label={A.bcc}>{list(input.bcc)}</Field>
                    <Field label={A.subject}>{text(input.subject)}</Field>
                  </>
                ) : (
                  <>
                    {item.context ? <Field label={A.current}>{[item.context.summary, [shownTime(item.context.start), shownTime(item.context.end)].filter(Boolean).join(' – ')].filter(Boolean).join(' · ')}</Field> : null}
                    <Field label={A.eventTitle}>{text(input.summary)}</Field>
                    <Field label={A.time}>{input.start || input.end ? [shownTime(input.start, input.timezone), shownTime(input.end)].filter(Boolean).join(' – ') : null}</Field>
                    <Field label={A.location}>{text(input.location)}</Field>
                    <Field label={A.attendees}>{list(input.attendees)}</Field>
                    {list(input.attendees) ? <Field label={A.notify}>{input.notify_attendees === false ? A.notifyNo : A.notifyYes}</Field> : null}
                  </>
                )}
              </View>
              {body ? <View style={styles.body}><Text style={cardText.body}>{body}</Text></View> : null}
              <View style={styles.actions}>
                <CardButton label={A.decline} disabled={busy !== null} onPress={() => void decide(item, false)} />
                <CardButton primary label={email ? A.approveSend : A.approveSave} disabled={busy !== null && busy !== item.id} busy={busy === item.id} onPress={() => void decide(item, true)} />
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
  const email = item.action === 'send_email'
  const Icon = email ? Mail : CalendarClock
  return (
    <View style={styles.heading}>
      <Symbol name={email ? 'envelope' : 'calendar'} size={17} web={<Icon size={18} color={colors.ink} strokeWidth={1.8} />} />
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

'use client'

import { useFormatter, useTranslations } from '@/lib/intl/i18n-client'
import type { Definition } from '@/lib/schedules/contract'
import { cronShape } from './automation-draft'

const clock = (hour: number, minute: number) => `${hour}:${String(minute).padStart(2, '0')}`

/** 「工作日 9:00」: one line for an automation's timing, in its own time zone, then its GitHub triggers and webhook. */
export function useTimingSummary() {
  const t = useTranslations('Automations.summary')
  const tEvent = useTranslations('Automations.githubEvent')
  const tLinear = useTranslations('Automations.linearEvent')
  const tSlack = useTranslations('Automations.slackEvent')
  const timing = useScheduleSummary()
  return (definition: Pick<Definition, 'timing' | 'timezone' | 'events' | 'webhook'>) => {
    const github = (definition.events ?? []).flatMap(trigger => trigger.source === 'github' ? [trigger] : [])
    const linear = (definition.events ?? []).flatMap(trigger => trigger.source === 'linear' ? [trigger] : [])
    const slack = (definition.events ?? []).flatMap(trigger => trigger.source === 'slack' ? [trigger] : [])
    const parts = [
      ...(github.length ? [t('github', { event: tEvent(github[0]!.event), count: github.length - 1 })] : []),
      ...(linear.length ? [t('linear', { event: tLinear(linear[0]!.event), count: linear.length - 1 })] : []),
      ...(slack.length ? [t('slack', { event: tSlack(slack[0]!.event), count: slack.length - 1 })] : []),
      ...(definition.webhook ? [t('webhook')] : []),
    ]
    if (!parts.length) return timing(definition)
    return [...(definition.timing.kind === 'manual' ? [] : [timing(definition)]), ...parts].join(' · ')
  }
}

const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'UTC' } }

function useScheduleSummary() {
  const t = useTranslations('Automations.summary')
  const format = useFormatter()
  return (definition: Pick<Definition, 'timing' | 'timezone'>) => {
    const timing = definition.timing
    // Capy's row names the zone beside the time (`Monday at 9:00 AM (America/New_York)`); its own zone is left off.
    const zone = definition.timezone === viewerZone() ? '' : ` (${definition.timezone})`
    if (timing.kind === 'manual') return t('manual')
    if (timing.kind === 'once') return t('once', { time: format.dateTime(new Date(timing.at), { dateStyle: 'medium', timeStyle: 'short', timeZone: definition.timezone }) })
    if (timing.kind === 'interval') {
      const minutes = timing.minutes
      if (minutes % 1440 === 0) return t('intervalDays', { count: minutes / 1440 })
      if (minutes % 60 === 0) return t('intervalHours', { count: minutes / 60 })
      return t('intervalMinutes', { count: minutes })
    }
    if (timing.kind === 'daily') { const [hour, minute] = timing.time.split(':').map(Number); return t('daily', { time: clock(hour!, minute!) }) + zone }
    const shape = cronShape(timing.expression)
    if (!shape) return t('cron', { expression: timing.expression })
    const time = clock(shape.hour, shape.minute)
    if (shape.kind === 'monthly') return t('monthly', { day: shape.day, time }) + zone
    if (shape.kind === 'weekly') {
      // 2026-11-15 is a Sunday: day 0 maps to it, 1 to Monday and so on.
      const weekday = format.dateTime(new Date(Date.UTC(2026, 10, 15 + shape.day, 12)), { weekday: 'long', timeZone: 'UTC' })
      return t('weekly', { weekday, time }) + zone
    }
    return t(shape.kind, { time }) + zone
  }
}

/** The next run as the automation's own clock reads it, naming the zone when it is not the viewer's, so it agrees with the summary. */
export function useNextRunLabel() {
  const format = useFormatter()
  // Intl refuses timeZoneName beside dateStyle/timeStyle, so the fields are spelled out.
  return (at: string | Date, timezone: string) => format.dateTime(new Date(at), { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone, ...(timezone === viewerZone() ? {} : { timeZoneName: 'short' }) })
}

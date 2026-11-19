import 'server-only'
import { createTranslator } from '@/lib/intl/i18n-server'
import { pool } from '@/lib/db'
import { BASE_PATH } from '@/lib/base-path'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { installationCredential } from './installation-store'
import type { RunNotice } from '@/lib/schedules/store'

/** Slack mrkdwn: escape the three characters Slack reserves. */
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The app's public link to a task, for a message outside the app. */
function taskLink(id: string, env: NodeJS.ProcessEnv) {
  const origin = env.BETTER_AUTH_URL ?? env.MIKKA_APP_ORIGIN
  if (!origin) return null
  try { return `${new URL(origin).origin}${BASE_PATH}${workspaceLink({ issue: id })}` } catch { return null }
}

/**
 * 运行后发到 Slack (decision 2026-11-15-2040): one line in the automation's channel, as the workspace's Slack app, in the
 * locale saved with the automation. The task is a link back to the app; the error is its code's copy, never raw output.
 */
export async function postRunNotice(notice: RunNotice, env: NodeJS.ProcessEnv = process.env, send: typeof fetch = fetch) {
  const app = env.SLACK_APP_ID
  if (!app) throw new Error('slackNotConfigured')
  // Written outside a request, in the locale saved with the automation.
  const messages = (notice.locale === 'en' ? await import('@/messages/en.json') : await import('@/messages/zh-CN.json')).default
  const t = createTranslator({ locale: notice.locale, messages, namespace: 'AutomationSlack' })
  const errors = createTranslator({ locale: notice.locale, messages, namespace: 'Errors' })
  const title = escape(notice.title)
  let text: string
  if (notice.status === 'succeeded') {
    const link = notice.task ? taskLink(notice.task.id, env) : null
    const name = notice.task ? escape(notice.task.identifier ?? notice.task.title) : null
    text = name ? t('succeeded', { title, task: link ? `<${link}|${name}>` : name }) : t('succeededNoTask', { title })
  } else {
    const reason = notice.error && errors.has(notice.error as never) ? errors(notice.error as never) : t('failedUnknown')
    text = t('failed', { title, reason: escape(reason) })
  }
  const token = await installationCredential(pool, { app, owner: notice.ownerId, workspace: notice.workspaceId }, { settings: true })
  const response = await send('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: notice.channel, text, unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json() as { ok?: boolean; error?: string }
  if (!response.ok || !body.ok) throw new Error(`slackPostFailed:${body.error ?? response.status}`)
}

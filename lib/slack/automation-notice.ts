import 'server-only'
import { createTranslator } from '@/lib/intl/i18n-server'
import { pool } from '@/lib/db'
import { BASE_PATH } from '@/lib/base-path'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { installationCredential } from './installation-store'
import type { RunNotice } from '@/lib/schedules/store'

/** Slack mrkdwn: escape the three characters Slack reserves. */
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The app's public link to a page, for a message outside the app. */
function appLink(path: string, env: NodeJS.ProcessEnv) {
  const origin = env.BETTER_AUTH_URL ?? env.MIKKA_APP_ORIGIN
  if (!origin) return null
  try { return `${new URL(origin).origin}${BASE_PATH}${path}` } catch { return null }
}
const taskLink = (id: string, env: NodeJS.ProcessEnv) => appLink(workspaceLink({ issue: id }), env)
const automationLink = (id: string, env: NodeJS.ProcessEnv) => appLink(`${workspaceLink({ section: 'automations' })}&automation=${encodeURIComponent(id)}`, env)
/** Slack's chat:write.customize: posting under another name and picture. Installations from before it was asked for lack it. */
export const SLACK_CUSTOMIZE_SCOPE = 'chat:write.customize'

/** The run-as person as Slack shows them: their name and, when it is a public https image, their picture. */
async function runnerIdentity(userId: string) {
  const { rows: [user] } = await pool.query<{ name: string | null; image: string | null }>('SELECT name,image FROM "user" WHERE id=$1', [userId])
  if (!user?.name) return null
  const image = user.image?.startsWith('https://') ? user.image : null
  return { username: user.name.slice(0, 80), ...(image ? { icon_url: image } : {}) }
}

/**
 * 运行后发到 Slack (decision 2026-11-15-2040): a line in the automation's channel, as the workspace's Slack app or, when
 * asked, as the person it runs as, in the locale saved with the automation; quiet leaves out the status mark and footer.
 * The task is a link back to the app; the error is its code's copy, never raw output.
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
  const use = { app, owner: notice.ownerId, workspace: notice.workspaceId }
  // Post as the run-as person when asked and the installation was granted chat:write.customize; otherwise as the app.
  let token: string | null = null, identity: Awaited<ReturnType<typeof runnerIdentity>> = null
  if (notice.postAsRunner) {
    try { token = await installationCredential(pool, use, { settings: true, requiredScope: SLACK_CUSTOMIZE_SCOPE }) }
    catch (error) { if (!(error instanceof Error && error.message === 'slackInstallNotAuthorized')) throw error }
    if (token) identity = await runnerIdentity(notice.ownerId)
  }
  token ??= await installationCredential(pool, use, { settings: true })
  // Quiet: the line alone. Otherwise a status mark and a footer linking the automation.
  const link = automationLink(notice.scheduleId, env)
  const blocks = notice.quiet ? undefined : [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${notice.status === 'succeeded' ? '✅' : '⚠️'} ${t(notice.status === 'succeeded' ? 'statusSucceeded' : 'statusFailed')} · ${t('footer', { automation: link ? `<${link}|${title}>` : title })}` }] },
  ]
  const response = await send('https://slack.com/api/chat.postMessage', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel: notice.channel, text, ...(blocks ? { blocks } : {}), ...identity, unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(10_000),
  })
  const body = await response.json() as { ok?: boolean; error?: string }
  if (!response.ok || !body.ok) throw new Error(`slackPostFailed:${body.error ?? response.status}`)
}

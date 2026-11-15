import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

// The bot token comes from the installation store (tests/slack-installation.db.test.ts); here it is a fixed stand-in.
const credentials: unknown[] = []
mock.module(new URL('./installation-store.ts', import.meta.url).href, { namedExports: { installationCredential: async (_pool: unknown, input: unknown) => { credentials.push(input); return 'unit-only-bot-token' } } })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {} } })
let post: typeof import('./automation-notice')['postRunNotice']
before(async () => { ({ postRunNotice: post } = await import('./automation-notice')) })
const env = { SLACK_APP_ID: 'A1', BETTER_AUTH_URL: 'https://app.example.test' } as NodeJS.ProcessEnv
const notice = { ownerId: 'u1', workspaceId: 'w1', scheduleId: 's1', title: 'Deploy <check> & ship', channel: 'C1', locale: 'zh-CN' as const, status: 'succeeded' as const,
  task: { id: 'i1', identifier: 'ENG-7', title: 'Ship' }, error: null }

test('a finished run is one line in its channel, as the workspace’s Slack app, linking the task, in the saved locale', async () => {
  const sent: Array<{ url: string; init: RequestInit }> = []
  const send = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return Response.json({ ok: true }) }) as unknown as typeof fetch
  await post(notice, env, send)
  assert.equal(sent[0]!.url, 'https://slack.com/api/chat.postMessage')
  assert.equal(new Headers(sent[0]!.init.headers).get('authorization'), 'Bearer unit-only-bot-token')
  const body = JSON.parse(String(sent[0]!.init.body))
  assert.equal(body.channel, 'C1')
  assert.match(body.text, /^自动化「Deploy &lt;check&gt; &amp; ship」运行完成：<https:\/\/app\.example\.test[^|]*\?issue=i1\|ENG-7>$/)
  assert.deepEqual(credentials.at(-1), { app: 'A1', owner: 'u1', workspace: 'w1' })
  await post({ ...notice, locale: 'en', status: 'failed', task: null, error: 'scheduleBotUnavailable' }, env, send)
  assert.match(JSON.parse(String(sent[1]!.init.body)).text, /^Automation "Deploy &lt;check&gt; &amp; ship" did not run: /)
})

test('Slack refusing the post is an error for the caller to log', async () => {
  const send = (async () => Response.json({ ok: false, error: 'not_in_channel' })) as unknown as typeof fetch
  await assert.rejects(post(notice, env, send), /slackPostFailed:not_in_channel/)
})

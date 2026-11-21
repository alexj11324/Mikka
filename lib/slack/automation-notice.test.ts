import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

// The bot token comes from the installation store (tests/slack-installation.db.test.ts); here it is a fixed stand-in.
const credentials: unknown[] = []
// Installations granted these scopes; one without chat:write.customize posts as the app.
const scopes = new Set(['chat:write', 'chat:write.customize'])
mock.module(new URL('./installation-store.ts', import.meta.url).href, { namedExports: { installationCredential: async (_pool: unknown, input: unknown, options: { requiredScope?: string } = {}) => {
  if (options.requiredScope && !scopes.has(options.requiredScope)) throw new Error('slackInstallNotAuthorized')
  credentials.push(input); return 'unit-only-bot-token'
} } })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: { query: async () => ({ rows: [{ name: 'Ada Runner', image: 'https://images.example.test/ada.png' }] }) } } })
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

test('a run is posted as the person it runs as when asked and granted; quiet is the line alone', async () => {
  const bodies: Record<string, unknown>[] = []
  const send = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ ok: true }) }) as unknown as typeof fetch
  await post({ ...notice, postAsRunner: true }, env, send)
  assert.deepEqual([bodies[0]!.username, bodies[0]!.icon_url], ['Ada Runner', 'https://images.example.test/ada.png'])
  const blocks = bodies[0]!.blocks as Array<{ type: string; elements?: Array<{ text: string }> }>
  assert.deepEqual(blocks.map(block => block.type), ['section', 'context'])
  assert.match(blocks[1]!.elements![0]!.text, /^✅ 已完成 · <https:\/\/app\.example\.test[^|]*automation=s1\|Deploy &lt;check&gt; &amp; ship> · Mikka$/)
  await post({ ...notice, quiet: true }, env, send)
  assert.deepEqual(['blocks' in bodies[1]!, 'username' in bodies[1]!], [false, false], 'quiet, and as the app unless asked')
  scopes.delete('chat:write.customize')
  try {
    await post({ ...notice, postAsRunner: true }, env, send)
    assert.equal('username' in bodies[2]!, false, 'an installation without chat:write.customize posts as the app')
  } finally { scopes.add('chat:write.customize') }
})

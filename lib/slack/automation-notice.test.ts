import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { startExternalServices } from '../../tests/fakes/external-services.mjs'
import { LOCAL_SLACK_SIGNING_SECRET, LOCAL_SLACK_TOKEN } from '../../tests/fakes/slack.mjs'
import { validSlackSignature } from './webhook'

// The bot token comes from the installation store (tests/slack-installation.db.test.ts); here it is a fixed stand-in.
const credentials: unknown[] = []
// Installations granted these scopes; one without chat:write.customize posts as the app.
const scopes = new Set(['chat:write', 'chat:write.customize'])
mock.module(new URL('./installation-store.ts', import.meta.url).href, { namedExports: { installationCredential: async (_pool: unknown, input: unknown, options: { requiredScope?: string } = {}) => {
  if (options.requiredScope && !scopes.has(options.requiredScope)) throw new Error('slackInstallNotAuthorized')
  credentials.push(input); return LOCAL_SLACK_TOKEN
} } })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: { query: async () => ({ rows: [{ name: 'Ada Runner', image: 'https://images.example.test/ada.png' }] }) } } })
let post: typeof import('./automation-notice')['postRunNotice']
before(async () => { ({ postRunNotice: post } = await import('./automation-notice')) })
const env = { SLACK_APP_ID: 'A1', BETTER_AUTH_URL: 'https://app.example.test' } as NodeJS.ProcessEnv
const notice = { ownerId: 'u1', workspaceId: 'w1', scheduleId: 's1', title: 'Deploy <check> & ship', channel: 'C1', locale: 'zh-CN' as const, status: 'succeeded' as const,
  task: { id: 'i1', identifier: 'ENG-7', title: 'Ship' }, error: null }

test('a finished run is one line in its channel, as the workspace’s Slack app, linking the task, in the saved locale', async t => {
  const services = await startExternalServices()
  t.after(() => services.close())
  const sent: Array<{ url: string; init: RequestInit }> = []
  const send = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return services.fetch(url, init) }) as unknown as typeof fetch
  await post(notice, env, send)
  assert.equal(sent[0]!.url, 'https://slack.com/api/chat.postMessage')
  assert.equal(new Headers(sent[0]!.init.headers).get('authorization'), `Bearer ${LOCAL_SLACK_TOKEN}`)
  const body = JSON.parse(String(sent[0]!.init.body))
  assert.equal(body.channel, 'C1')
  assert.match(body.text, /^自动化「Deploy &lt;check&gt; &amp; ship」运行完成：<https:\/\/app\.example\.test[^|]*\?issue=i1\|ENG-7>$/)
  assert.deepEqual(credentials.at(-1), { app: 'A1', owner: 'u1', workspace: 'w1' })
  await post({ ...notice, locale: 'en', status: 'failed', task: null, error: 'scheduleBotUnavailable' }, env, send)
  assert.match(JSON.parse(String(sent[1]!.init.body)).text, /^Automation "Deploy &lt;check&gt; &amp; ship" did not run: /)
  assert.equal(services.slack.messages.length, 2)
})

test('Slack refusing the post is an error for the caller to log', async t => {
  const services = await startExternalServices()
  t.after(() => services.close())
  for (const failure of ['not_in_channel', 'invalid_auth', 'channel_not_found', 'ratelimited']) {
    services.slack.state.failure = failure
    await assert.rejects(post(notice, env, services.fetch), new RegExp(`slackPostFailed:${failure}`))
  }
  assert.equal(services.slack.messages.length, 0)
})

test('a run is posted as the person it runs as when asked and granted; quiet is the line alone', async t => {
  const services = await startExternalServices()
  t.after(() => services.close())
  const bodies: Record<string, unknown>[] = []
  const send = (async (url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return services.fetch(url, init) }) as unknown as typeof fetch
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

test('the HTTP boundary refuses run-as identity without Slack customize scope', async t => {
  const services = await startExternalServices({ slack: { scopes: ['chat:write'] } })
  t.after(() => services.close())
  await assert.rejects(post({ ...notice, postAsRunner: true }, env, services.fetch), /slackPostFailed:missing_scope/)
  assert.equal(services.slack.messages.length, 0)
})

test('Slack fixture events pass the real signature verifier and fail after tampering or expiry', async t => {
  const now = Date.parse('2026-11-20T00:00:00Z')
  const services = await startExternalServices({ slack: { now: () => now } })
  t.after(() => services.close())
  const event = services.slack.eventRequest('http://127.0.0.1/events', { type: 'event_callback', event: { type: 'message', text: 'fixture event' } })
  const body = await event.text(), timestamp = event.headers.get('x-slack-request-timestamp'), signature = event.headers.get('x-slack-signature')
  assert.equal(validSlackSignature(body, timestamp, signature, LOCAL_SLACK_SIGNING_SECRET, now), true)
  assert.equal(validSlackSignature(body + ' ', timestamp, signature, LOCAL_SLACK_SIGNING_SECRET, now), false)
  assert.equal(validSlackSignature(body, timestamp, signature, LOCAL_SLACK_SIGNING_SECRET, now + 301_000), false)
})

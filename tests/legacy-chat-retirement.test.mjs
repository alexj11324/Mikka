import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { sessionPreview } from '../lib/agent-history.ts'
import { webUrlSchema } from '../lib/search/url-schema.ts'
const source = path => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('Retired chat route exposes only the shared image GET, with no generation or credential/model imports', async () => {
  const route = await source('app/api/agent/route.ts')
  assert.match(route, /export \{ GET \} from '\.\/images\/route'/)
  assert.doesNotMatch(route, /POST|HEAD|streamText|OPENCODE|createAgentWebTools|beginAgentTurn/)
  const archive = await source('components/workspace/legacy-chat-archive.tsx')
  assert.doesNotMatch(archive, /useCompletion|complete\(|AgentComposer|onSubmit|method:\s*'POST'/)
  assert.match(archive, /continueFromAnswer: async \(\) => false/)
  assert.doesNotMatch(archive, /<div inert>|AgentGenerativeUI/)
  assert.match(archive, /<LegacyReplyContent/)
  assert.match(archive, /fetchAgentHistory/)
  // The left column lists bots only; an older chat opens from ⌘K, read-only.
  const nav = await source('components/nav/bot-list.tsx')
  assert.match(nav, /Nav\.newBot/)
  assert.doesNotMatch(nav, /choose\(\{ kind: 'agent'/)
  assert.doesNotMatch(nav, /sessions.map|recent.map/)
  assert.match(await source('components/nav/global-search.tsx'), /Nav\.openBotChat|tNav\('openBotChat'\)/)
  assert.match(await source('components/nav/global-search.tsx'), /archivedConversation/)
})

test('Owner-scoped history stays readable; generation write helpers are retired and schema retained', async () => {
  const store = await source('lib/agent-store.ts')
  assert.match(store, /export async function getAgentHistory/)
  assert.match(store, /eq\(agentSessions.userId, userId\)/)
  assert.match(store, /eq\(agentTurns.userId, userId\)/)
  assert.doesNotMatch(store, /beginAgentTurn|saveAgentTurn|\.insert\(|\.update\(|\.delete\(/)
  const schema = await source('lib/db/schema.ts')
  assert.match(schema, /pgTable\('agent_sessions'/)
  assert.match(schema, /pgTable\('agent_turns'/)
  assert.equal(sessionPreview('root = TextContent("Existing saved message")', 'question'), 'Existing saved message')
  assert.match(await source('app/api/agent/sessions/route.ts'), /getAgentHistory\(session.user.id/)
})

test('Public HTTPS scrape boundary rejects literals, credentials, local names and non-HTTPS', () => {
  for (const value of ['http://site.org', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]', 'https://user:secret@site.org', 'https://x.internal', 'https://x.local.', 'https://site.org:8080']) assert.equal(webUrlSchema.safeParse(value).success, false, value)
  assert.equal(webUrlSchema.safeParse('https://www.iana.org/help/example-domains').success, true)
})

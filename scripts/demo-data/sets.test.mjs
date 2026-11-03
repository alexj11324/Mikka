import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { CONTENT_SETS, DEMO_PREFIX, demoId, parseArgs, where } from './shared.mjs'
import { loadContent } from './sets.mjs'
import { threadIssues, withIssues } from './thread-issues.mjs'

const sets = Object.fromEntries(await Promise.all(CONTENT_SETS.map(async name => [name, await loadContent(name)])))
const keys = list => list.map(item => item.key).sort()
const threads = set => Object.entries(set.BOT_THREADS).flatMap(([bot, list]) => list.map(([title, status], index) => ({ key: `t-${bot}-${index}`, issue: null, bot, status, prompt: title })))

test('without options the seed keeps writing the zh set under de300000- with the ids it always had', () => {
  const args = parseArgs(['--email', 'a@b.example'])
  assert.deepEqual({ prefix: args.prefix, content: args.content, refreshTimes: args.refreshTimes, userId: args.userId }, { prefix: 'de300000-', content: 'zh', refreshTimes: false, userId: null })
  const h = createHash('sha256').update('owner-1:demo-data-v1:bot:frontend').digest('hex')
  assert.equal(demoId('owner-1', 'bot:frontend'), `de300000-${h.slice(0, 4)}-4${h.slice(4, 7)}-8${h.slice(7, 10)}-${h.slice(10, 22)}`)
})

test('another prefix gives every row a different id and its own cleanup filter', () => {
  const args = parseArgs(['--email', 'a@b.example', '--prefix', 'de300001-', '--content', 'en', '--user-id', 'u1', '--refresh-times'])
  assert.deepEqual({ prefix: args.prefix, content: args.content, userId: args.userId, refreshTimes: args.refreshTimes }, { prefix: 'de300001-', content: 'en', userId: 'u1', refreshTimes: true })
  const zh = demoId('owner-1', 'bot:frontend')
  const en = demoId('owner-1', 'bot:frontend', 'de300001-')
  assert.ok(en.startsWith('de300001-'))
  assert.equal(en.slice(9), zh.slice(9))
  assert.equal(where({ column: 'id', owner: 'userId' }, 'de300001-'), `"id"::text LIKE 'de300001-%' AND "userId" = $1`)
  assert.equal(where({ column: 'id' }), `"id"::text LIKE '${DEMO_PREFIX}%'`)
  for (const bad of ['de30000-', 'de300001', "de30000'-", 'ab300001-']) assert.throws(() => parseArgs(['--email', 'a@b.example', '--prefix', bad]), /--prefix/)
  assert.throws(() => parseArgs(['--email', 'a@b.example', '--content', 'fr']), /--content/)
  assert.throws(() => where({ column: 'id' }, "x' OR true --"), /prefix/)
})

test('every content set has the same bots, tasks and threads, so one seed writes either', () => {
  const [zh, en] = [sets.zh, sets.en]
  assert.deepEqual(keys(en.BOTS), keys(zh.BOTS))
  assert.deepEqual(keys(en.PEOPLE), keys(zh.PEOPLE))
  assert.deepEqual(keys(en.DEVICES), keys(zh.DEVICES))
  assert.deepEqual(keys(en.AGENTS), keys(zh.AGENTS))
  const own = list => list.filter(key => key !== 'coordinator').sort()
  assert.deepEqual(own(Object.keys(en.CHATS)), Object.keys(zh.CHATS).sort())
  assert.deepEqual(own(Object.keys(en.BOT_THREADS)), Object.keys(zh.BOT_THREADS).sort())
  for (const bot of Object.keys(zh.BOT_THREADS)) assert.equal(en.BOT_THREADS[bot].length, zh.BOT_THREADS[bot].length, bot)
  assert.equal(en.ISSUES.length, zh.ISSUES.length)
  assert.equal(en.RUNS.length, zh.RUNS.length)
  assert.deepEqual(en.RUNS.map(run => run.status), zh.RUNS.map(run => run.status))
  assert.equal(typeof en.threadOpening, 'function')
})

test('the en set references only keys it defines', () => {
  const en = sets.en
  const issueKeys = new Set(en.ISSUES.map(issue => issue.key))
  const created = threadIssues([...en.RUNS, ...threads(en)])
  const allIssues = new Set([...issueKeys, ...created.map(issue => issue.key)])
  assert.equal(allIssues.size, en.ISSUES.length + created.length, 'task keys stay unique')
  assert.ok(withIssues([...en.RUNS, ...threads(en)]).every(run => allIssues.has(run.issue)), 'each run points at a task that will be seeded')
  const runs = new Set(en.RUNS.map(run => run.key))
  const bots = new Set([...en.BOTS, en.COORDINATOR].map(bot => bot.key))
  const artifacts = new Set(en.ARTIFACTS.map(artifact => artifact.key))
  const people = new Set(en.PEOPLE.map(person => person.key))
  const text = JSON.stringify([en.CHATS, en.RUNS])
  for (const [, kind, key] of text.matchAll(/\{\{(issue|run|bot|artifact):([\w-]+)\}\}/g)) {
    assert.ok({ issue: allIssues, run: runs, bot: bots, artifact: artifacts }[kind].has(key), `${kind}:${key}`)
  }
  for (const run of en.RUNS) { assert.ok(!run.issue || issueKeys.has(run.issue), run.key); assert.ok(bots.has(run.bot), run.key) }
  for (const issue of en.ISSUES) {
    assert.ok(!issue.assignee || issue.assignee === 'me' || people.has(issue.assignee) || bots.has(issue.assignee.slice(4)), issue.key)
    for (const ref of [issue.parent, issue.duplicateOf].filter(Boolean)) assert.ok(issueKeys.has(ref), `${issue.key} → ${ref}`)
  }
  for (const message of en.GROUP.messages) assert.ok(message.by === 'me' || people.has(message.by) || bots.has(message.by.slice(4)), message.by)
  assert.ok(en.BOTS.some(bot => bot.key === 'release'), 'the group chat is led by the release bot')
})

test('the en set is English only, and no visible name calls it a sample', () => {
  const en = sets.en
  const visible = JSON.stringify([en.WORKSPACE_NAME, en.TEAM, en.PEOPLE, en.BOTS, en.ISSUES, en.DEVICES, en.AGENTS, en.RUNS, en.ARTIFACTS, en.SUGGESTIONS, en.COORDINATOR, en.BOT_MEMORY, en.BOT_THREADS, en.CHATS, en.GROUP, en.threadOpening('x')])
  const cjk = visible.match(/[　-〿㐀-鿿＀-￯]/g)
  assert.equal(cjk, null, `CJK characters: ${cjk?.join('')}`)
  const names = [en.WORKSPACE_NAME, en.TEAM.name, ...en.PEOPLE.flatMap(person => [person.name, person.email]), ...en.BOTS.map(bot => bot.name), ...en.DEVICES.flatMap(device => [device.name, device.hostname]), ...en.AGENTS.map(agent => agent.name), en.GROUP.title]
  for (const name of names) assert.doesNotMatch(name, /demo|test|sample|fake|dummy/i, name)
})

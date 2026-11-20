import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { checkPullRequest } from './pr-acceptance-github.mjs'

const head = '679022e02d24c445bcf23235e1e68ff757830d84'
async function github(t, { files = [{ filename: 'docs/guide.md' }], body = '', draft = false, changeOnRead, readStatus = 200 } = {}) {
  const pr = { state: 'open', head: { sha: head }, base: { sha: 'b'.repeat(40) }, body, draft, changed_files: files.length, labels: [] }
  const writes = [], pages = []
  let reads = 0, labelExists = false
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null
    res.setHeader('content-type', 'application/json')
    const reply = (status, value) => { res.statusCode = status; res.end(JSON.stringify(value)) }
    if (req.method !== 'GET') writes.push({ path: req.url, method: req.method, data })
    if (req.url === '/repos/example/project/pulls/7') {
      reads++
      if (changeOnRead) changeOnRead(pr, reads)
      reply(readStatus, pr)
    } else if (req.url.startsWith('/repos/example/project/pulls/7/files?')) {
      const page = Number(new URL(req.url, 'http://127.0.0.1').searchParams.get('page'))
      pages.push(page)
      reply(200, files.slice((page - 1) * 100, page * 100))
    } else if (req.url === '/repos/example/project/labels/acceptance%3Amissing') reply(labelExists ? 200 : 404, labelExists ? { name: 'acceptance:missing' } : {})
    else if (req.url === '/repos/example/project/labels' && req.method === 'POST') { labelExists = true; reply(201, data) }
    else if (req.url === '/repos/example/project/issues/7/labels' && req.method === 'POST') { pr.labels = data.labels.map(name => ({ name })); reply(200, pr.labels) }
    else if (req.url === '/repos/example/project/issues/7/labels/acceptance%3Amissing' && req.method === 'DELETE') { pr.labels = []; reply(200, []) }
    else if (/^\/repos\/example\/project\/statuses\/[a-f0-9]{40}$/.test(req.url) && req.method === 'POST') reply(201, { id: writes.length, ...data })
    else reply(404, {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { pr, writes, pages, args: { repository: 'example/project', number: 7, apiBase: `http://127.0.0.1:${server.address().port}`, token: 'fixture-token', publish: true } }
}

test('missing evidence posts failure and label; a PR edit posts success and removes it', async t => {
  const fixture = await github(t)
  assert.equal((await checkPullRequest(fixture.args)).status, 'fail')
  assert.deepEqual(fixture.pr.labels, [{ name: 'acceptance:missing' }])
  assert.deepEqual(fixture.writes.filter(item => item.path.includes('/statuses/')).map(item => item.data.state), ['pending', 'failure'])
  fixture.pr.body = '## Acceptance\nNot needed: documentation wording only; links verified.'
  assert.equal((await checkPullRequest(fixture.args)).status, 'pass')
  assert.deepEqual(fixture.pr.labels, [])
  assert.deepEqual(fixture.writes.filter(item => item.path.includes('/statuses/')).map(item => [item.data.context, item.data.state]), [
    ['PR acceptance', 'pending'], ['PR acceptance', 'failure'], ['PR acceptance', 'pending'], ['PR acceptance', 'success'],
  ])
})

test('all changed-file pages participate in screenshot admission', async t => {
  const files = Array.from({ length: 100 }, (_, n) => ({ filename: `lib/file-${n}.ts` }))
  files.push({ filename: 'components/task-row.tsx' })
  const fixture = await github(t, { files, body: `## Acceptance\nRuntime: device\nModel: scripted\nCommit: ${head}\nFixtures: task-row\nItems: 1 — 1/1 passed` })
  const result = await checkPullRequest(fixture.args)
  assert.deepEqual(fixture.pages, [1, 2])
  assert(result.errors.includes('acceptance.screenshot-missing'))
  assert.equal(fixture.writes.at(-1).data.state, 'failure')
})

test('editing the body during the check cannot publish a stale success', async t => {
  const fixture = await github(t, { body: '## Acceptance\nNot needed: documentation only.', changeOnRead: (pr, reads) => { if (reads === 2) pr.body = '' } })
  await assert.rejects(checkPullRequest(fixture.args), { code: 'prAcceptanceChangedDuringCheck' })
  assert.deepEqual(fixture.writes.map(item => item.data.state), ['pending'])
})

test('a previous-head success never supplies acceptance for a changed head', async t => {
  const fixture = await github(t, { body: '## Acceptance\nNot needed: documentation only.' })
  assert.equal((await checkPullRequest(fixture.args)).status, 'pass')
  const nextHead = 'c'.repeat(40)
  fixture.pr.head.sha = nextHead
  fixture.pr.body = ''
  assert.equal((await checkPullRequest(fixture.args)).status, 'fail')
  const states = fixture.writes.filter(item => item.path.includes('/statuses/'))
    .map(item => [item.path.split('/').at(-1), item.data.state])
  assert.deepEqual(states, [[head, 'pending'], [head, 'success'], [nextHead, 'pending'], [nextHead, 'failure']])
})

test('a head change during the check leaves the old head pending instead of passing', async t => {
  const fixture = await github(t, { body: '## Acceptance\nNot needed: documentation only.', changeOnRead: (pr, reads) => { if (reads === 2) pr.head.sha = 'c'.repeat(40) } })
  await assert.rejects(checkPullRequest(fixture.args), { code: 'prAcceptanceChangedDuringCheck' })
  assert.deepEqual(fixture.writes.map(item => item.data.state), ['pending'])
})

test('draft stays pending without evaluating files or adding a missing-evidence label', async t => {
  const fixture = await github(t, { draft: true })
  assert.equal((await checkPullRequest(fixture.args)).status, 'draft')
  assert.deepEqual(fixture.pages, [])
  assert.deepEqual(fixture.pr.labels, [])
  assert.deepEqual(fixture.writes.map(item => item.data.state), ['pending'])
})

test('read-only inspection does not mutate the PR', async t => {
  const fixture = await github(t)
  assert.equal((await checkPullRequest({ ...fixture.args, publish: false })).status, 'fail')
  assert.deepEqual(fixture.writes, [])
})

test('publishing fails closed for an incomplete GitHub file inventory', async t => {
  const fixture = await github(t)
  fixture.pr.changed_files = 3001
  await assert.rejects(checkPullRequest(fixture.args), { code: 'prAcceptanceFileInventoryIncomplete' })
  assert.deepEqual(fixture.writes.map(item => item.data.state), ['pending'])
})

test('an edited webhook invalidates the same-head success before a failed PR read', async t => {
  const fixture = await github(t, { readStatus: 503 })
  await assert.rejects(checkPullRequest({ ...fixture.args, eventHead: head }), { code: 'prAcceptanceGitHubHttp503' })
  assert.deepEqual(fixture.writes.map(item => [item.path, item.data.state]), [
    [`/repos/example/project/statuses/${head}`, 'pending'],
  ])
})

test('a delayed webhook checks and publishes the current head instead of reusing its event head', async t => {
  const fixture = await github(t, { body: '## Acceptance\nNot needed: documentation only.' })
  fixture.pr.head.sha = 'c'.repeat(40)
  assert.equal((await checkPullRequest({ ...fixture.args, eventHead: head })).head, fixture.pr.head.sha)
  assert.deepEqual(fixture.writes.map(item => [item.path.split('/').at(-1), item.data.state]), [
    [head, 'pending'], [fixture.pr.head.sha, 'pending'], [fixture.pr.head.sha, 'success'],
  ])
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { answerModel } from './model.mjs'
import { subscriptionPrompt, subscriptionChunks, MVP_SUBSCRIPTION_MODEL } from './subscription.mjs'
import { REPOSITORY } from './isolated-env.mjs'
import { finishMvpResources, indexMvpResource } from './retention.mjs'

const execute = promisify(execFile)
const git = async (cwd, args) => (await execute('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
const REPO_PATH = '/repos/mikka-e2e/core-loop'
const REPOSITORY_ID = 789
const READ_TOKEN = 'mvp-synthetic-installation-read'
const WRITE_TOKEN = 'mvp-synthetic-installation-write'

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 2_000_000) throw new Error('Fixture request exceeds its limit')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

/** Loopback only. Real git changes are required before the fake GitHub accepts a PR. */
export async function startMvpServices(port = 3191) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-mvp-origin-'))
  await indexMvpResource('origin-directory', directory)
  let scenario = null
  let observations = []
  let errors = []
  let pullRequests = []
  const streams = new Map()
  const observe = item => observations.push({ at: new Date().toISOString(), ...item })
  const server = createServer(async (request, response) => {
    const requestId = `mvp-${randomUUID()}`
    const url = new URL(request.url, 'http://127.0.0.1')
    const reply = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'x-mvp-request-id': requestId }); response.end(JSON.stringify(value)) }
    try {
      if (url.pathname === '/health') return reply({ ready: true })
      if (url.pathname === '/observations') return reply({ observations, errors, pullRequests: pullRequests.map(pr => ({ number: pr.number, url: pr.html_url, branch: pr.head.ref, draft: pr.draft })) })
      if (url.pathname === '/streaming/scenario' && request.method === 'POST') {
        const input = await readBody(request)
        assert.match(input.marker, /^mvp-stream-[a-f0-9-]{36}$/)
        for (const text of [input.first, input.last]) assert.ok(typeof text === 'string' && text.length > 0 && text.length <= 256)
        assert.ok(!streams.has(input.marker))
        let release
        const held = new Promise(resolve => { release = resolve })
        streams.set(input.marker, { ...input, held, release, started: 0, released: false })
        return reply({ configured: true })
      }
      if (['/streaming/state', '/streaming/release'].includes(url.pathname) && request.method === 'POST') {
        const { marker } = await readBody(request)
        const stream = streams.get(marker)
        assert.ok(stream)
        if (url.pathname === '/streaming/release') { stream.released = true; stream.release() }
        return reply({ started: stream.started, released: stream.released })
      }
      if (url.pathname === '/scenario' && request.method === 'POST') {
        const input = await readBody(request)
        assert.match(input.marker, /^mvp-[a-f0-9-]{36}$/)
        assert.equal(typeof input.title, 'string')
        assert.ok(input.title.length < 180)
        const githubAccountId = Number(input.githubAccountId ?? '456')
        assert.ok(Number.isSafeInteger(githubAccountId) && githubAccountId > 0)
        observations = []; errors = []; pullRequests = []
        const source = join(directory, input.marker, 'seed')
        const barePath = join(directory, input.marker, 'origin.git')
        await mkdir(source, { recursive: true })
        await git(source, ['init', '--initial-branch=trunk'])
        await writeFile(join(source, 'README.md'), '# MVP fixture\n')
        await git(source, ['add', 'README.md'])
        await git(source, ['-c', 'user.name=Mikka CI', '-c', 'user.email=mikka-ci@example.com', 'commit', '-m', 'test: seed isolated origin'])
        await git(source, ['clone', '--bare', '--no-hardlinks', '.', barePath])
        scenario = { marker: input.marker, title: input.title, repo: REPOSITORY, deviceId: null, barePath, githubAccountId }
        return reply({ barePath, repo: REPOSITORY, baseBranch: 'trunk' })
      }
      if (url.pathname === '/scenario/device' && request.method === 'POST') {
        const { deviceId } = await readBody(request)
        assert.ok(scenario)
        assert.match(deviceId, /^[a-f0-9-]{36}$/)
        scenario.deviceId = deviceId
        return reply({ configured: true })
      }
      if (url.pathname === '/subscription/model' && request.method === 'POST') {
        const payload=await readBody(request)
        assert.equal(payload.model,MVP_SUBSCRIPTION_MODEL)
        observe({kind:'subscription-model-request',requestId})
        const prompt=subscriptionPrompt(payload)
        const stream=[...streams.values()].find(value=>prompt.prompt.some(message=>message.role==='user' && message.content.some(part=>part.type==='text' && part.text.includes(value.marker))))
        const answer=stream ? null : answerModel(prompt,scenario,observe)
        response.writeHead(200,{'content-type':'text/event-stream'})
        if(stream) {
          stream.started++
          const first=subscriptionChunks({content:[{type:'text',text:stream.first}]},payload.model).split('\n\n')[0]
          response.write(first+'\n\n')
          await stream.held
          return response.end(subscriptionChunks({content:[{type:'text',text:stream.last}]},payload.model))
        }
        return response.end(subscriptionChunks(answer,payload.model))
      }
      if (url.pathname === '/v1/language-model' && request.method === 'POST') {
        observe({ kind: 'model-request', requestId })
        return reply(answerModel(await readBody(request), scenario, observe))
      }
      if (url.pathname === '/decisions' && request.method === 'POST') {
        // The real triage transport still validates a model response and issues
        // its own execution receipt. This scripted response is only evidence of
        // that integration contract, never live model judgment or authorization.
        assert.equal(request.headers.authorization, 'Bearer mvp-synthetic-decisions')
        const input = await readBody(request)
        assert.equal(input.model, 'openai/gpt-6-luna-decisions')
        assert.equal(input.questions?.length, 1)
        const question = input.questions[0]
        assert.equal(question.type, 'choice')
        assert.equal(input.input?.length, 1)
        assert.equal(input.input[0].role, 'user')
        assert.equal(input.input[0].content?.length, 1)
        assert.equal(input.input[0].content[0].type, 'input_text')
        if (question.name === 'outcome') {
          // An ended run's outcome (lib/run-outcome.ts): the run's facts, one per line.
          assert.deepEqual(question.choices?.map(choice => choice.value), ['done', 'blocked', 'needs_input', 'failed', 'idle'])
          const facts = input.input[0].content[0].text
          const status = /^status: (succeeded|stopped|failed|cancelled)\nstop reason: .+\nattempts on this task: [1-9][0-9]*\ntask: .+\npull requests: .+\nsummary \(quoted\): .+\nlast reply \(quoted\): .+$/.exec(facts)?.[1]
          assert.ok(status, 'Unexpected run outcome evidence')
          observe({ kind: 'outcome-request', requestId, status })
          return reply({
            model: input.model,
            provider_metadata: { gateway: { generationId: `mvp-synthetic-${randomUUID()}`, cost: '0.001' } },
            answers: [{ type: 'choice', name: 'outcome', choice: status === 'succeeded' ? 'done' : 'idle' }],
          })
        }
        assert.equal(question.name, 'tier')
        assert.deepEqual(question.choices?.map(choice => choice.value), ['attention', 'result', 'background'])
        const state = JSON.parse(input.input[0].content[0].text)
        const host = JSON.parse(state.hostObservation)
        assert.ok(['run_finished', 'action_decided'].includes(host.eventKind), 'Unexpected MVP runtime event')
        assert.match(host.eventId, /^[a-f0-9-]{36}$/)
        assert.equal(typeof host.ownerId, 'string')
        if (host.eventKind === 'run_finished') {
          assert.equal(host.observedRun?.id, host.runId)
          assert.ok(['succeeded', 'failed', 'cancelled'].includes(host.observedRun?.status))
        }
        observe({ kind: 'decision-request', requestId, eventId: host.eventId, eventKind: host.eventKind })
        return reply({
          model: input.model,
          provider_metadata: { gateway: { generationId: `mvp-synthetic-${randomUUID()}`, cost: '0.001' } },
          answers: [{ type: 'choice', name: 'tier', choice: 'result' }],
        })
      }
      if (!url.pathname.startsWith('/github/')) throw new Error('Unexpected fixture route')
      assert.ok(scenario, 'GitHub called before the fixture scenario exists')
      const githubUser = { id: scenario.githubAccountId, login: `mvp-owner-${scenario.githubAccountId}` }
      const path = decodeURIComponent(url.pathname.slice('/github'.length))
      const method = request.method ?? 'GET'
      observe({ kind: 'github-request', requestId, method, path })
      const bearer = request.headers.authorization
      const readAccess = () => assert.equal(bearer, `Bearer ${READ_TOKEN}`, 'Expected repository read token')
      const writeAccess = () => assert.equal(bearer, `Bearer ${WRITE_TOKEN}`, 'Expected repository PR token')
      const appAccess = () => assert.match(bearer ?? '', /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'Expected an App JWT')
      if (path === `${REPO_PATH}/installation` && method === 'GET') {
        appAccess()
        return reply({ id: 99, suspended_at: null, permissions: { pull_requests: 'write', contents: 'write' } })
      }
      if (path === '/app/installations/99/access_tokens' && method === 'POST') {
        appAccess()
        const input = await readBody(request)
        if (input.permissions?.pull_requests === 'write') {
          assert.deepEqual(input, { repository_ids: [REPOSITORY_ID], permissions: { metadata: 'read', pull_requests: 'write' } })
          return reply({ token: WRITE_TOKEN })
        }
        assert.deepEqual(input, { repositories: ['core-loop'], permissions: { metadata: 'read', contents: 'read' } })
        return reply({ token: READ_TOKEN })
      }
      if (path === `/user/${githubUser.id}` && method === 'GET') { readAccess(); return reply(githubUser) }
      if (path === `${REPO_PATH}/collaborators/${githubUser.login}/permission` && method === 'GET') { readAccess(); return reply({ permission: 'write', user: githubUser }) }
      if (path === REPO_PATH && method === 'GET') { readAccess(); return reply({ id: REPOSITORY_ID, full_name: 'mikka-e2e/core-loop', default_branch: 'trunk' }) }
      if (path.startsWith(`${REPO_PATH}/git/ref/heads/`) && method === 'GET') {
        readAccess()
        const branch = path.slice(`${REPO_PATH}/git/ref/heads/`.length)
        assert.match(branch, /^mikka\/[a-z0-9-]+-[1-9][0-9]*$/)
        const sha = await git(scenario.barePath, ['rev-parse', '--verify', `refs/heads/${branch}`]).catch(() => null)
        if (!sha) return reply({ message: 'Branch was not pushed' }, 404)
        observe({ kind: 'pushed-branch', branch, sha })
        return reply({ object: { sha } })
      }
      if (path === `${REPO_PATH}/pulls` && method === 'GET') {
        writeAccess()
        const head = url.searchParams.get('head')
        assert.equal(url.searchParams.get('state'), 'all')
        return reply(pullRequests.filter(pr => `mikka-e2e:${pr.head.ref}` === head))
      }
      if (path === `${REPO_PATH}/pulls` && method === 'POST') {
        writeAccess()
        const input = await readBody(request)
        assert.match(input.head, /^mikka\/[a-z0-9-]+-[1-9][0-9]*$/)
        assert.equal(input.base, 'trunk', 'PR must use the actual origin default branch')
        assert.match(input.body, /<!-- mikka-issue:[a-f0-9-]{36} -->$/)
        const commit = await git(scenario.barePath, ['rev-parse', '--verify', `refs/heads/${input.head}`])
        assert.match(await git(scenario.barePath, ['show', `${commit}:MIKKA_MOCK.md`]), /Written by the real Mikka mock harness/)
        const message = await git(scenario.barePath, ['show', '-s', '--format=%B', commit])
        const runId = message.match(/Mikka-Run: ([a-f0-9-]{36})/)?.[1]
        const issueId = message.match(/Mikka-Issue: ([a-f0-9-]{36})/)?.[1]
        assert.ok(runId && issueId, 'The pushed commit must carry its real run/task provenance')
        assert.ok(input.body.endsWith(`<!-- mikka-issue:${issueId} -->`))
        assert.equal(pullRequests.some(pr => pr.head.ref === input.head), false, 'A replay must find the existing PR')
        const number = 41 + pullRequests.length
        const pr = { number, html_url: `https://github.com/mikka-e2e/core-loop/pull/${number}`, state: 'open', draft: input.draft === true, merged_at: null, body: input.body, head: { ref: input.head, repo: { id: REPOSITORY_ID } }, base: { repo: { id: REPOSITORY_ID } } }
        pullRequests.push(pr)
        observe({ kind: 'pull-request-created', requestId, runId, issueId, commit, branch: input.head, url: pr.html_url })
        return reply(pr, 201)
      }
      throw new Error(`Unexpected GitHub operation: ${method} ${path}`)
    } catch (error) {
      // Never expose request bodies/headers or assertion diffs containing a JWT.
      const message = error instanceof assert.AssertionError ? 'Fixture contract assertion failed' : error instanceof Error ? error.message : 'Fixture request failed'
      errors.push({ requestId, path: url.pathname, message })
      reply({ error: message }, 500)
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const stream of streams.values()) stream.release()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await finishMvpResources()
    },
  }
}

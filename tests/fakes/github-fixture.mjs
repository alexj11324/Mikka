import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createGitHubRoutes } from './github.mjs'
import { externalServiceFetch } from './external-services.mjs'
import { json } from './http.mjs'

const execute = promisify(execFile)
const git = async (cwd, args) => (await execute('git', ['-c', 'user.name=HTTP fixture', '-c', 'user.email=fixture@example.test', ...args],
  { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()

/** Real local Git state, shared HTTP handler, no GitHub access or model call. */
export async function githubFixture({ conflict = false, githubAccountId = 456 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-github-http-')), source = join(directory, 'source'), bare = join(directory, 'origin.git')
  await git(directory, ['init', '--initial-branch=trunk', source])
  await writeFile(join(source, 'README.md'), 'base\n')
  await git(source, ['add', 'README.md']); await git(source, ['commit', '-m', 'initial'])
  await git(directory, ['clone', '--bare', source, bare])
  await git(source, ['switch', '-c', 'mikka/http-1'])
  await writeFile(join(source, conflict ? 'README.md' : 'feature.txt'), 'feature\n')
  await git(source, ['add', '.']); await git(source, ['commit', '-m', 'feature'])
  await git(source, ['push', bare, 'HEAD:refs/heads/mikka/http-1'])
  const head = await git(source, ['rev-parse', 'HEAD'])
  if (conflict) {
    await git(source, ['switch', 'trunk'])
    await writeFile(join(source, 'README.md'), 'conflicting base\n')
    await git(source, ['add', '.']); await git(source, ['commit', '-m', 'base changes'])
    await git(source, ['push', bare, 'HEAD:refs/heads/trunk'])
  }
  const pulls = [{ number: 41, node_id: 'MVP_PR_41', title: 'HTTP fake acceptance', html_url: 'https://github.com/mikka-e2e/core-loop/pull/41',
    state: 'open', draft: false, merged: false, head: { ref: 'mikka/http-1', repo: { id: 789 } }, base: { ref: 'trunk', repo: { id: 789 } } }]
  const scenario = { barePath: bare, githubAccountId, harness: 'synthetic-codex' }, observations = []
  const github = createGitHubRoutes({ getScenario: () => scenario, getPullRequests: () => pulls, git, observe: item => observations.push(item), origin: 'http://127.0.0.1' })
  const server = createServer(async (request, response) => {
    try {
      if (!await github.routes(request, response, new URL(request.url, 'http://127.0.0.1'), randomUUID())) json(response, { message: 'Not found' }, 404)
    } catch { json(response, { message: 'Invalid fixture request' }, 400) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, head, github, pulls, observations, fetch: externalServiceFetch(origin),
    currentBase: () => git(bare, ['rev-parse', 'refs/heads/trunk']),
    parents: sha => git(bare, ['show', '-s', '--format=%P', sha]),
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) } }
}

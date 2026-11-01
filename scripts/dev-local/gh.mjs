#!/usr/bin/env node
// Fixed local fixture CLI. Never connects to GitHub or claims real CI evidence.
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { MVP_SERVICES } from '../../tests/mvp/isolated-env.mjs'

const REPO = 'mikka-e2e/core-loop'
const RUN_TOKEN = 'mvp-synthetic-installation-run'
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export async function fixtureGh(args, { env = process.env, origin = MVP_SERVICES, fetcher = fetch, gitRun = git, output = value => process.stdout.write(`${value}\n`) } = {}) {
  if (env.GH_TOKEN !== RUN_TOKEN || env.GH_REPO !== REPO || (env.GH_HOST && env.GH_HOST !== 'github.com')) throw new Error('Local fixture credentials required')
  const options = new Map(), positional = []
  for (let index = 0; index < args.length; index++) {
    const value = args[index]
    if (value.startsWith('-')) {
      if (['--draft', '--watch', '--fill', '--required', '--fail-fast', '--web', '--version'].includes(value)) { options.set(value, true); continue }
      if (index + 1 >= args.length) throw new Error('Missing local fixture option')
      const values = options.get(value) ?? []
      values.push(args[++index]); options.set(value, values)
    } else positional.push(value)
  }
  const option = (...names) => names.map(name => options.get(name)?.at(-1)).find(value => value !== undefined)
  if (option('--repo', '-R') && option('--repo', '-R') !== REPO) throw new Error('Local fixture repository required')
  const api = async (path, method = 'GET', body) => {
    if (path !== 'graphql' && path !== `repos/${REPO}` && !path.startsWith(`repos/${REPO}/`)) throw new Error('Unsupported local fixture API')
    const response = await fetcher(`${origin}/github/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${RUN_TOKEN}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`Local fixture API HTTP ${response.status}`)
    return response.json()
  }
  const print = value => {
    const jq = option('--jq', '-q')
    if (jq) {
      if (!/^\.[a-zA-Z][a-zA-Z0-9]*$/.test(jq)) throw new Error('Unsupported local fixture jq expression')
      output(String(value[jq.slice(1)]))
    } else output(JSON.stringify(value))
  }
  const findPr = async identifier => {
    if (identifier && identifier.startsWith('https://github.com/')) {
      const match = /^https:\/\/github\.com\/mikka-e2e\/core-loop\/pull\/([1-9][0-9]*)$/.exec(identifier)
      if (!match) throw new Error('Local fixture pull request required')
      identifier = match[1]
    }
    if (identifier && /^[1-9][0-9]*$/.test(identifier)) return api(`repos/${REPO}/pulls/${identifier}`)
    const branch = identifier || gitRun(['branch', '--show-current'])
    const rows = await api(`repos/${REPO}/pulls?state=all&head=${encodeURIComponent(`mikka-e2e:${branch}`)}`)
    if (rows.length !== 1) throw new Error('Local fixture pull request unavailable')
    return rows[0]
  }
  const project = pr => ({ number: pr.number, url: pr.html_url, title: pr.title, body: pr.body, headRefOid: pr.head.sha, headRefName: pr.head.ref, baseRefName: pr.base.ref, isDraft: pr.draft, state: pr.state.toUpperCase() })
  if (options.has('--version')) { output('gh version local-fixture (synthetic GitHub transport)'); return }
  if (positional[0] === 'auth' && positional[1] === 'status') { output('Local fixture authenticated for mikka-e2e/core-loop (synthetic token)'); return }
  if (positional[0] === 'repo' && positional[1] === 'view') {
    if (positional[2] && positional[2] !== REPO) throw new Error('Local fixture repository required')
    const repository = await api(`repos/${REPO}`)
    const view = { name: 'core-loop', nameWithOwner: REPO, url: `https://github.com/${REPO}`, defaultBranchRef: { name: repository.default_branch }, isPrivate: false }
    if (options.has('--json')) print(view); else output(`${REPO} (local fixture)`)
    return
  }
  if (positional[0] === 'api') {
    const path = positional[1]
    const fields = [...(options.get('-f') ?? []), ...(options.get('-F') ?? []), ...(options.get('--field') ?? []), ...(options.get('--raw-field') ?? [])]
    const body = Object.fromEntries(fields.map(field => { const index = field.indexOf('='); if (index < 1) throw new Error('Invalid fixture API field'); return [field.slice(0, index), field.slice(index + 1)] }))
    print(await api(path, option('--method', '-X') ?? (fields.length ? 'POST' : 'GET'), fields.length ? body : undefined)); return
  }
  if (positional[0] !== 'pr') throw new Error('Local fixture supports gh pr and gh api only')
  if (positional[1] === 'list') {
    const head = option('--head', '-H')
    const query = new URLSearchParams({ state: 'all', ...(head ? { head: head.includes(':') ? head : `mikka-e2e:${head}` } : {}) })
    const state = option('--state', '-s') ?? 'open'
    const rows = (await api(`repos/${REPO}/pulls?${query}`)).filter(pr => state === 'all' || pr.state === state)
    if (options.has('--json')) print(rows.map(project))
    else output(rows.map(pr => `${pr.number}\t${pr.title}\t${pr.head.ref}`).join('\n'))
    return
  }
  if (positional[1] === 'create') {
    const head = option('--head', '-H') ?? gitRun(['branch', '--show-current'])
    let body = option('--body', '-b')
    const bodyFile = option('--body-file', '-F')
    if (bodyFile) body = bodyFile === '-' ? await (async () => { let text = ''; for await (const chunk of process.stdin) text += chunk; return text })() : await readFile(bodyFile, 'utf8')
    if (!body) throw new Error('Local fixture PR body is required')
    const rows = await api(`repos/${REPO}/pulls?state=all&head=${encodeURIComponent(`mikka-e2e:${head}`)}`)
    const pr = rows[0] ?? await api(`repos/${REPO}/pulls`, 'POST', { head, base: option('--base', '-B') ?? 'trunk', title: option('--title', '-t') ?? gitRun(['log', '-1', '--format=%s']), body, draft: options.has('--draft') })
    output(pr.html_url); return
  }
  const pr = await findPr(positional[2])
  if (positional[1] === 'view') { if (options.has('--json')) print(project(pr)); else output(pr.html_url); return }
  if (positional[1] === 'checks') {
    const checks = await api(`repos/${REPO}/commits/${pr.head.sha}/check-runs`)
    if (checks.check_runs.some(check => check.conclusion !== 'success')) throw new Error('Local fixture check failed')
    if (options.has('--json')) print(checks.check_runs.map(check => ({ name: check.name, state: 'SUCCESS', bucket: 'pass', link: check.html_url })))
    else output(`Local fixture diff (synthetic CI)\tpass\t${pr.head.sha}`)
    return
  }
  throw new Error('Unsupported local fixture gh command')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fixtureGh(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}

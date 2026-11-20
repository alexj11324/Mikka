import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acceptanceSummary, inspectAcceptance } from './pr-acceptance-check.mjs'

const label = 'acceptance:missing'
const context = 'PR acceptance'
const fail = (code, cause) => { throw Object.assign(new Error(code, { cause }), { code }) }
const snapshot = pr => JSON.stringify([pr.head?.sha, pr.base?.sha, pr.body, pr.draft, pr.state])

/** Inspect current GitHub metadata. PR files/body are data: this driver neither
 * downloads nor executes code from the head branch, even for fork PRs. */
export async function checkPullRequest({ repository, number, token, publish = false,
  apiBase = 'https://api.github.com', targetUrl, eventHead } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !Number.isSafeInteger(number) || number < 1) fail('prAcceptanceInvalidTarget')
  const api = new URL(apiBase)
  if (api.username || api.password || api.search || api.hash || api.pathname !== '/' ||
      !(api.origin === 'https://api.github.com' || ['127.0.0.1', '[::1]'].includes(api.hostname))) fail('prAcceptanceInvalidApiOrigin')
  if (publish && !token) fail('prAcceptanceTokenRequired')
  if (eventHead && !/^[a-f0-9]{40}$/.test(eventHead)) fail('prAcceptanceInvalidEventHead')
  const root = `/repos/${repository}`
  const endpoint = `${root}/pulls/${number}`
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
    'user-agent': 'mikka-pr-acceptance', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  async function request(path, { method = 'GET', body, missing = false } = {}) {
    let response
    try {
      response = await fetch(new URL(path, api), { method, headers,
        ...(body ? { headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        redirect: 'error', signal: AbortSignal.timeout(20_000) })
    } catch (cause) { fail('prAcceptanceGitHubTransport', cause) }
    if (missing && response.status === 404) return null
    if (!response.ok) fail(`prAcceptanceGitHubHttp${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  const detailsUrl = targetUrl ?? `https://github.com/${repository}/pull/${number}`
  const status = (head, state, description) => request(`${root}/statuses/${head}`, { method: 'POST', body: {
    state, context, description, target_url: detailsUrl,
  } })
  // An edited body does not change the commit SHA. In Actions, invalidate its
  // old success before reading metadata so a failed GET cannot leave it green.
  if (publish && eventHead) await status(eventHead, 'pending', 'Refreshing the PR acceptance declaration')
  const pr = await request(endpoint)
  if (pr.state !== 'open' || !/^[a-f0-9]{40}$/.test(pr.head?.sha ?? '')) fail('prAcceptanceNotOpen')
  if (publish && (eventHead !== pr.head.sha || pr.draft)) await status(pr.head.sha, 'pending',
    pr.draft ? 'Draft; mark ready to evaluate acceptance' : 'Checking the current PR acceptance declaration')
  const files = []
  if (!pr.draft) {
    if (!Number.isSafeInteger(pr.changed_files) || pr.changed_files < 0 || pr.changed_files > 3000) fail('prAcceptanceFileInventoryIncomplete')
    for (let page = 1; files.length < pr.changed_files; page++) {
      const entries = await request(`${endpoint}/files?per_page=100&page=${page}`)
      if (!Array.isArray(entries) || !entries.length) fail('prAcceptanceFileInventoryIncomplete')
      files.push(...entries)
    }
    if (files.length !== pr.changed_files) fail('prAcceptanceFileInventoryIncomplete')
  }
  const result = inspectAcceptance({ body: pr.body, files, draft: pr.draft })
  if (publish) {
    if (snapshot(await request(endpoint)) !== snapshot(pr)) fail('prAcceptanceChangedDuringCheck')
    const hasLabel = pr.labels?.some(item => (typeof item === 'string' ? item : item.name) === label)
    if (result.status === 'fail' && !hasLabel) {
      if (!await request(`${root}/labels/${encodeURIComponent(label)}`, { missing: true })) {
        try {
          await request(`${root}/labels`, { method: 'POST', body: { name: label, color: 'd73a4a', description: 'PR Acceptance declaration is missing required evidence' } })
        } catch (cause) {
          // Concurrent PR checks can create this same repository label.
          if (cause.code !== 'prAcceptanceGitHubHttp422' || !await request(`${root}/labels/${encodeURIComponent(label)}`, { missing: true })) throw cause
        }
      }
      await request(`${root}/issues/${number}/labels`, { method: 'POST', body: { labels: [label] } })
    } else if (result.status !== 'fail' && hasLabel) {
      await request(`${root}/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE', missing: true })
    }
    if (snapshot(await request(endpoint)) !== snapshot(pr)) fail('prAcceptanceChangedDuringCheck')
    if (result.status !== 'draft') await status(pr.head.sha, result.status === 'pass' ? 'success' : 'failure',
      result.status === 'pass' ? `Acceptance declaration passed (${result.mode})` : 'Acceptance evidence missing; see workflow summary')
  }
  return { ...result, repository, number, head: pr.head.sha }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('Usage: node scripts/ci/pr-acceptance-github.mjs [--input FILE | --repo OWNER/REPO --pr NUMBER] [--publish]\nWithout --input, reads current GitHub PR metadata. --publish updates its PR acceptance status and acceptance:missing label; requires GITHUB_TOKEN. No model or PR head code is executed.')
    return
  }
  let input, repository = process.env.GITHUB_REPOSITORY, number, eventHead, publish = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--publish') publish = true
    else if (args[i] === '--input') input = args[++i]
    else if (args[i] === '--repo') repository = args[++i]
    else if (args[i] === '--pr') number = Number(args[++i])
    else fail('prAcceptanceUnknownArgument')
  }
  if (input && publish) fail('prAcceptanceInputCannotPublish')
  if (!input && process.env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    if (!number) number = event.pull_request?.number
    if (event.repository?.full_name === repository && event.pull_request?.number === number) eventHead = event.pull_request.head?.sha
  }
  const targetUrl = process.env.GITHUB_RUN_ID && repository
    ? `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined
  const result = input ? inspectAcceptance(JSON.parse(await readFile(input, 'utf8'))) : await checkPullRequest({
    repository, number, token: process.env.GITHUB_TOKEN, publish, targetUrl, eventHead,
  })
  const summary = acceptanceSummary(result)
  console.log(JSON.stringify({ status: result.status, mode: result.mode, head: result.head, errors: result.errors }))
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## PR acceptance\n\n${summary}\n`)
  if (result.status === 'fail') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Do not echo PR text, API bodies, credentials, or raw transport messages.
    console.error(error.code ?? 'prAcceptanceFailed')
    process.exitCode = 1
  })
}

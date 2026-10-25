// Explicit, opt-in nonproduction smoke test. Never loaded by CI/unit suites.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createAgentWebTools } from '../lib/agent-web-tools.ts'
import { createWebService } from '../lib/search/index.ts'
import { createFirecrawlProvider } from '../lib/search/firecrawl.ts'

assert.equal(process.env.MIKKA_FIRECRAWL_LIVE_ACCEPTANCE, 'keyless-public-two-requests', 'Explicit live acceptance opt-in required')
assert.equal(Boolean(process.env.FIRECRAWL_API_KEY), false, 'This acceptance permits only keyless calls; do not unset an existing configured key')
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
assert.equal(dirty, '', 'Commit implementation before recording exact-SHA evidence')
const requests = []
const provider = createFirecrawlProvider(async (url, init) => {
  assert.ok(['https://api.firecrawl.dev/v2/search', 'https://api.firecrawl.dev/v2/scrape'].includes(url))
  assert.equal(init.headers.Authorization, undefined)
  assert.ok(requests.length < 2, 'Two-request live budget exceeded')
  const entry = { endpoint: url, startedAt: new Date().toISOString() }
  requests.push(entry)
  const response = await fetch(url, init)
  entry.httpStatus = response.status
  entry.finishedAt = new Date().toISOString()
  return response
})
const web = createWebService({ provider })
const controller = new AbortController()
const tools = createAgentWebTools({ signal: controller.signal, context: { userId: 'nonproduction-public-smoke', caller: 'agent-panel' }, search: web.search, scrape: web.scrape })
const toolContext = { toolCallId: 'public-smoke', messages: [], abortSignal: controller.signal }
const startedAt = new Date().toISOString()
const search = await tools.web_search.execute({ query: 'IANA example domains documentation' }, toolContext)
const page = await tools.read_webpage.execute({ url: 'https://www.iana.org/help/example-domains' }, toolContext)
const evidence = {
  sha, startedAt, finishedAt: new Date().toISOString(), keyless: true, requestBudget: 2, requests,
  search: search.ok ? { ok: true, resultCount: search.results.length, sourceURLs: search.results.map(result => result.url), retrievedAt: search.retrievedAt, untrustedContent: search.untrustedContent } : search,
  scrape: page.ok ? { ok: true, url: page.url, markdownCharacters: page.content.length, expectedPublicHeading: /Example Domains/i.test(page.content), retrievedAt: page.retrievedAt, untrustedContent: page.untrustedContent } : page,
  scope: 'Actual Agent tool → shared SearchProvider → hosted Firecrawl, direct cloud Linux, no Mikka session/model/browser/Preview',
}
console.log(JSON.stringify(evidence, null, 2))
if (!search.ok || search.results.length === 0 || !page.ok || !/Example Domains/i.test(page.content)) process.exitCode = 1

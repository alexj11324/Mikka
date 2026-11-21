import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { findRepository, resolveRepository, withResolvedRepository, type RepositoryLister } from './repository-resolution'
import { GITHUB_APP_INSTALL_URL } from '@/lib/github/repository-match'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs'
import { createTracerProvider, SafeExporter } from '../tracing/node'
import { createLogProvider } from '../tracing/logs'
import { withDispatchTiming, type DispatchTiming } from '../dispatch-timing'

const ISSUE = '550e8400-e29b-41d4-a716-446655440000'
const repos = (...names: string[]) => ({ repositories: names.map(fullName => ({ fullName, private: true })) })
/** Each user's own list; the lister is only ever asked for the dispatching user. */
const byUser: Record<string, ReturnType<typeof repos>> = {
  alex: repos('alexj11324/Mikka_test', 'alexj11324/Mikka', 'mikka-org/web'),
  other: repos('someone/secret-repo', 'someone/Mikka_test', 'org2/mikka-test'),
}
const lister = () => mock.fn<RepositoryLister>(async userId => byUser[userId] ?? repos())
const noContext = async () => ({ text: '', used: [] })
const accessError = (code: string) => Object.assign(new Error(code), { name: 'GitHubAccessError', code, status: 409 })

test('one match dispatches straight away with owner/repo; the lister is asked for the dispatching user only', async () => {
  for (const name of ['Mikka_test', 'mikka-test', 'MIKKA.TEST']) {
    const list = lister(), dispatch = mock.fn(async (repo: string) => ({ runId: 'run', repo }))
    assert.deepEqual(await withResolvedRepository('alex', ISSUE, name, dispatch, list), { runId: 'run', repo: 'alexj11324/Mikka_test' })
    assert.deepEqual(dispatch.mock.calls.map(call => call.arguments), [['alexj11324/Mikka_test']])
    assert.deepEqual(list.mock.calls.map(call => call.arguments), [['alex']])
  }
})

test('a GitHub repository named by owner/repo or URL runs only when the person\'s live list has it; no list, no dispatch; other hosts go on as given', async () => {
  for (const repo of ['alexj11324/Mikka_test', 'https://github.com/alexj11324/Mikka_test', 'git@github.com:alexj11324/Mikka_test.git']) {
    const dispatch = mock.fn(async (value: string) => value)
    assert.equal(await withResolvedRepository('alex', ISSUE, repo, dispatch, lister(), noContext), repo)
  }
  const dispatch = mock.fn(async (value: string) => value)
  const foreign = await withResolvedRepository('alex', ISSUE, 'someone/secret-repo', dispatch, lister(), noContext) as { error?: string }
  assert.equal(foreign.error, 'repositoryNotFound', 'an owner/repo outside the authorized list is refused')
  assert.equal(dispatch.mock.callCount(), 0)
  const elsewhere = mock.fn<RepositoryLister>(async () => repos())
  assert.equal(await withResolvedRepository('alex', ISSUE, 'https://gitlab.example/team/app.git', dispatch, elsewhere, noContext), 'https://gitlab.example/team/app.git')
  assert.equal(elsewhere.mock.callCount(), 0, 'another host is not asked of GitHub')
  // No list, no dispatch: not connected, authorization expired or revoked, GitHub down after one retry.
  const refused = mock.fn(async (value: string) => value)
  for (const code of ['githubNotConnected', 'githubReconnectRequired', 'githubUnavailable'])
    assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'octo/repo', refused, async () => { throw accessError(code) }, noContext), { error: code, repository: 'octo/repo', issueId: ISSUE })
  assert.equal(refused.mock.callCount(), 0)
})

test('several matches return the candidates as one choice card and dispatch nothing', async () => {
  const dispatch = mock.fn(async () => ({ runId: 'run' }))
  const list = mock.fn<RepositoryLister>(async () => repos('alexj11324/Mikka_test', 'mikka-org/mikka-test'))
  assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'mikka.test', dispatch, list, noContext), {
    error: 'repositoryAmbiguous', issueId: ISSUE,
    candidates: [{ fullName: 'alexj11324/Mikka_test', description: null, homepage: null, usedByThisWorkspace: false }, { fullName: 'mikka-org/mikka-test', description: null, homepage: null, usedByThisWorkspace: false }],
    card: { title: '多个仓库匹配 mikka.test', options: [{ value: 'alexj11324/Mikka_test', label: 'alexj11324/Mikka_test' }, { value: 'mikka-org/mikka-test', label: 'mikka-org/mikka-test' }] },
  })
  assert.equal(dispatch.mock.callCount(), 0)
})

test('no match returns the GitHub install option and dispatches nothing', async () => {
  const dispatch = mock.fn(async () => ({ runId: 'run' }))
  assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'nothing-here', dispatch, lister()), {
    error: 'repositoryNotFound', issueId: ISSUE,
    card: { title: '已授权的仓库里没有叫 nothing-here 的', options: [{ value: 'githubInstall', label: '在 GitHub 上授权更多仓库', action: 'githubInstall' }] },
  })
  assert.equal(dispatch.mock.callCount(), 0)
  assert.match(GITHUB_APP_INSTALL_URL, /\/api\/integrations\/github\/install$/)
})

test('another user\'s repositories are never matched', async () => {
  const list = lister(), dispatch = mock.fn(async (repo: string) => repo)
  const result = await withResolvedRepository('alex', ISSUE, 'secret-repo', dispatch, list)
  assert.equal('error' in Object(result) && (result as { error: string }).error, 'repositoryNotFound')
  assert.equal(dispatch.mock.callCount(), 0)
  // "Mikka_test" exists for the other user too, under two owners; alex still gets only his own one.
  assert.deepEqual(await resolveRepository('alex', 'Mikka_test', list), { repo: 'alexj11324/Mikka_test' })
  assert.deepEqual(list.mock.calls.map(call => call.arguments), [['alex'], ['alex']])
  assert.deepEqual(await findRepository('alex', 'secret-repo', list), { match: 'none', card: { title: '已授权的仓库里没有叫 secret-repo 的', options: [{ value: 'githubInstall', label: '在 GitHub 上授权更多仓库', action: 'githubInstall' }] } })
})

test('GitHub not connected or unavailable is a clear error and dispatches nothing; other failures still throw', async () => {
  const dispatch = mock.fn(async () => ({ runId: 'run' }))
  for (const code of ['githubNotConnected', 'githubNotConfigured', 'githubReconnectRequired', 'githubUnavailable']) {
    const list = mock.fn<RepositoryLister>(async () => { throw accessError(code) })
    assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'Mikka_test', dispatch, list), { error: code, repository: 'Mikka_test', issueId: ISSUE })
    assert.deepEqual(await findRepository('alex', 'Mikka_test', list), { error: code })
  }
  assert.equal(dispatch.mock.callCount(), 0)
  // A dispatch asks GitHub once more on a temporary failure, then says so; anything unexpected is that too.
  const flaky = mock.fn<RepositoryLister>(async () => { throw accessError('githubUnavailable') })
  assert.deepEqual(await resolveRepository('alex', 'Mikka_test', flaky), { error: 'githubUnavailable', repository: 'Mikka_test' })
  assert.equal(flaky.mock.callCount(), 2)
  let calls = 0
  const recovers: RepositoryLister = async userId => { if (calls++ === 0) throw accessError('githubUnavailable'); return lister()(userId) }
  assert.deepEqual(await resolveRepository('alex', 'Mikka_test', recovers), { repo: 'alexj11324/Mikka_test' })
  const revoked = mock.fn<RepositoryLister>(async () => { throw accessError('githubReconnectRequired') })
  await resolveRepository('alex', 'Mikka_test', revoked)
  assert.equal(revoked.mock.callCount(), 1, 'an expired authorization is not retried')
  assert.deepEqual(await resolveRepository('alex', 'Mikka_test', async () => { throw new Error('boom') }), { error: 'githubUnavailable', repository: 'Mikka_test' })
})

test('find_repository lists the user\'s own repositories, matches a name, and an owner/repo exactly', async () => {
  assert.deepEqual(await findRepository('alex', undefined, lister()), { total: 3, repositories: [{ fullName: 'alexj11324/Mikka_test', description: null, homepage: null }, { fullName: 'alexj11324/Mikka', description: null, homepage: null }, { fullName: 'mikka-org/web', description: null, homepage: null }] })
  assert.deepEqual(await findRepository('alex', '  ', lister()), { total: 3, repositories: [{ fullName: 'alexj11324/Mikka_test', description: null, homepage: null }, { fullName: 'alexj11324/Mikka', description: null, homepage: null }, { fullName: 'mikka-org/web', description: null, homepage: null }] })
  const many = mock.fn<RepositoryLister>(async () => repos(...Array.from({ length: 70 }, (_, index) => `o/r${index}`)))
  const listed = await findRepository('alex', undefined, many) as { total: number; repositories: unknown[] }
  assert.deepEqual([listed.total, listed.repositories.length], [70, 70])
  assert.deepEqual(await findRepository('alex', 'mikka test', lister()), { match: 'one', repository: 'alexj11324/Mikka_test', description: null, homepage: null })
  assert.deepEqual(await findRepository('alex', 'ALEXJ11324/mikka_test', lister()), { match: 'one', repository: 'alexj11324/Mikka_test', description: null, homepage: null })
  assert.deepEqual(await findRepository('alex', 'https://github.com/mikka-org/web.git', lister()), { match: 'one', repository: 'mikka-org/web', description: null, homepage: null })
  const several = await findRepository('other', 'mikka.test', lister()) as { match: string; candidates: { fullName: string }[] }
  assert.deepEqual([several.match, several.candidates.map(item => item.fullName)], ['several', ['someone/Mikka_test', 'org2/mikka-test']])
})

// Production (Acme): find_repository {name:"mikka"} returned match "one" (alexj11324/Mikka, an exact hit) and hid
// mikka-web, whose homepage is the site the person meant (「the How it works section on the Mikka site」).
const acme = () => mock.fn<RepositoryLister>(async () => ({ repositories: [
  { fullName: 'alexj11324/Mikka', private: true, description: 'Mikka app: bots, threads and the Coordinator', homepage: 'https://app.mikka.example' },
  { fullName: 'alexj11324/mikka-web', private: true, description: 'The Mikka marketing site', homepage: 'https://mikka.example' },
  { fullName: 'acme/mikka-enterprise', private: true, description: null, homepage: null },
] }))

test('an exact name never hides the others: every candidate comes back with its description and homepage', async () => {
  const found = await findRepository('alex', 'mikka', acme())
  assert.equal((found as { match: string }).match, 'several')
  assert.deepEqual((found as { candidates: unknown[] }).candidates, [
    { fullName: 'alexj11324/Mikka', description: 'Mikka app: bots, threads and the Coordinator', homepage: 'https://app.mikka.example', usedByThisWorkspace: false },
    { fullName: 'alexj11324/mikka-web', description: 'The Mikka marketing site', homepage: 'https://mikka.example', usedByThisWorkspace: false },
    { fullName: 'acme/mikka-enterprise', description: null, homepage: null, usedByThisWorkspace: false },
  ])
  assert.equal((await findRepository('alex', 'Mikka site', acme()) as { match: string }).match, 'several', 'no synonym decides "site"')
  assert.deepEqual(await findRepository('alex', 'alexj11324/mikka-web', acme()), { match: 'one', repository: 'alexj11324/mikka-web', description: 'The Mikka marketing site', homepage: 'https://mikka.example' })
})

test('dispatch_run with a bare name that several fit dispatches nothing; this workspace\'s repositories only come first', async () => {
  const dispatch = mock.fn(async (repo: string) => ({ runId: 'run', repo }))
  const result = await withResolvedRepository('alex', ISSUE, 'Mikka', dispatch, acme(), async () => ({ used: ['alexj11324/mikka-web'] })) as { error: string; candidates: { fullName: string; usedByThisWorkspace: boolean }[]; card: { options: { value: string }[] } }
  assert.equal(result.error, 'repositoryAmbiguous')
  assert.deepEqual(result.candidates.map(item => [item.fullName, item.usedByThisWorkspace]), [['alexj11324/mikka-web', true], ['alexj11324/Mikka', false], ['acme/mikka-enterprise', false]])
  assert.deepEqual(result.card.options.map(option => option.value), ['alexj11324/mikka-web', 'alexj11324/Mikka', 'acme/mikka-enterprise'])
  assert.equal(dispatch.mock.callCount(), 0, 'the workspace\'s own use orders the candidates; it never chooses')
  // The Coordinator judged them and passes owner/repo: dispatched as named.
  assert.deepEqual(await withResolvedRepository('alex', ISSUE, 'alexj11324/mikka-web', dispatch, acme(), noContext), { runId: 'run', repo: 'alexj11324/mikka-web' })
  const unreadable = await withResolvedRepository('alex', ISSUE, 'Mikka', dispatch, acme(), async () => { throw new Error('context unavailable') })
  assert.equal((unreadable as { error?: string }).error, 'repositoryAmbiguous')
})

test('sameRepository tells a named repository from the thread\'s', async () => {
  const { sameRepository } = await import('./repository-resolution')
  assert.equal(await sameRepository('alex', 'mikka-web', 'https://github.com/alexj11324/Mikka.git', acme()), false)
  assert.equal(await sameRepository('alex', 'alexj11324/Mikka', 'https://github.com/alexj11324/Mikka.git', acme()), true)
  assert.equal(await sameRepository('alex', 'Mikka', 'https://github.com/alexj11324/Mikka.git', acme()), null, 'a name several fit is not one repository yet')
})

test('on-demand discovery preserves every repository beyond 300 and marks only fresh authorized workspace candidates', async () => {
  const many = Array.from({ length: 321 }, (_, index) => ({
    fullName: 'octo/repository-' + index,
    description: 'Repository number ' + index,
    homepage: 'https://example.test/' + index,
  }))
  const list = mock.fn<RepositoryLister>(async () => ({ repositories: many }))
  const context = mock.fn(async () => ({ used: ['octo/repository-320', 'someone/forbidden'] }))
  const found = await findRepository('alex', undefined, list, context) as {
    total: number; repositories: { fullName: string; description: string | null; homepage: string | null; usedByThisWorkspace: boolean }[]
  }
  assert.equal(found.total, 321)
  assert.equal(found.repositories.length, 321)
  assert.deepEqual(found.repositories[0], { ...many[320], usedByThisWorkspace: true })
  assert.ok(found.repositories.some(repository => repository.fullName === 'octo/repository-319'))
  assert.ok(found.repositories.every(repository => repository.fullName.startsWith('octo/')))
  assert.equal(found.repositories.filter(repository => repository.usedByThisWorkspace).length, 1)
  assert.deepEqual(list.mock.calls.map(call => call.arguments), [['alex']])
  assert.equal(context.mock.callCount(), 1)
})

test('workspace discovery orders ambiguous names but neither authorizes nor silently picks a repository', async () => {
  const context = mock.fn(async () => ({ used: ['alexj11324/mikka-web', 'foreign/private'] }))
  const found = await findRepository('alex', 'Mikka', acme(), context) as {
    match: string; candidates: { fullName: string; usedByThisWorkspace: boolean }[]
  }
  assert.equal(found.match, 'several')
  assert.deepEqual(found.candidates.map(item => [item.fullName, item.usedByThisWorkspace]), [
    ['alexj11324/mikka-web', true], ['alexj11324/Mikka', false], ['acme/mikka-enterprise', false],
  ])
  const unavailable = mock.fn<RepositoryLister>(async () => { throw accessError('githubReconnectRequired') })
  const refusedContext = mock.fn(async () => { throw new Error('must not query workspace after a listing refusal') })
  assert.deepEqual(await findRepository('alex', undefined, unavailable, refusedContext), { error: 'githubReconnectRequired' })
  assert.equal(unavailable.mock.callCount(), 1, 'discovery adds no retry')
  assert.equal(refusedContext.mock.callCount(), 0)
})


test('closed repository refusals keep their exact result and mark phase plus dispatch beneath an OK Workflow step', async () => {
  const require = createRequire(import.meta.url), workflowRequire = createRequire(require.resolve('workflow'))
  const official = await import(pathToFileURL(join(dirname(workflowRequire.resolve('@workflow/core')), 'telemetry.js')).href)
  const memory = new InMemorySpanExporter(), logMemory = new InMemoryLogRecordExporter()
  const logs = createLogProvider({ endpoint: 'https://unused.test/i/v1/traces', token: 'unused', environment: 'dev', exporter: logMemory })
  const provider = createTracerProvider({ exporter: new SafeExporter(memory), sampleRate: 1, environment: 'dev', logger: logs.getLogger('test'), serverless: false })
  provider.register()
  try {
    const observations: { code: string; ownStatuses: number[]; ownCodes: unknown[]; parentStatus: number; failed: boolean; errorLogs: number }[] = []
    for (const code of ['githubNotConnected', 'githubNotConfigured', 'githubReconnectRequired', 'githubUnavailable', 'githubRepositoryForbidden', 'repositoryNotFound', 'repositoryAmbiguous']) {
      memory.reset(); logMemory.reset()
      const list = mock.fn<RepositoryLister>(async () => {
        if (code === 'repositoryNotFound') return repos()
        if (code === 'repositoryAmbiguous') return repos('one/repository', 'two/repository')
        throw Object.assign(new Error('PRIVATE_REFUSAL_MESSAGE'), { name: 'GitHubAccessError', code })
      })
      const dispatch = mock.fn(async () => ({ runId: 'never' })), lines: DispatchTiming[] = []
      const result = await official.trace('step.execute repository fixture', (step: { setAttribute(key: string, value: string): void }) => {
        step.setAttribute('workflow.run.id', 'wrun_repository_refusal_fixture')
        return withDispatchTiming(() => withResolvedRepository('PRIVATE_OWNER', ISSUE, 'repository', dispatch, list, noContext),
          Date.now, line => lines.push(line), async () => ({ workflowRunId: 'wrun_repository_refusal_fixture', stepId: 'step_fixture', attempt: 1 }))
      })
      assert.equal(result.error, code)
      assert.equal(result.issueId, ISSUE)
      if (code.startsWith('github')) assert.deepEqual(result, { error: code, repository: 'repository', issueId: ISSUE })
      assert.equal(dispatch.mock.callCount(), 0)
      assert.equal(list.mock.callCount(), code === 'githubUnavailable' ? 2 : 1, 'fresh authorization and existing retry semantics are unchanged')
      await provider.forceFlush(); await logs.forceFlush()
      const spans = memory.getFinishedSpans(), own = spans.filter(span => span.name.startsWith('dispatch'))
      const parent = spans.find(span => span.name === 'step.execute')!
      assert.equal(own.length, 2)
      assert.ok(own.every(span => span.spanContext().traceId === parent.spanContext().traceId))
      const root = own.find(span => span.name === 'dispatch_run')!, phase = own.find(span => span.name === 'dispatch.resolveRepository')!
      assert.equal(phase.parentSpanContext?.spanId, root.spanContext().spanId)
      assert.equal(root.parentSpanContext?.spanId, parent.spanContext().spanId)
      assert.doesNotMatch(JSON.stringify({ spans: spans.map(span => ({ attributes: span.attributes, status: span.status, events: span.events })), logs: logMemory.getFinishedLogRecords().map(record => ({ body: record.body, attributes: record.attributes })) }), /PRIVATE_OWNER|PRIVATE_REFUSAL_MESSAGE/)
      observations.push({ code, ownStatuses: own.map(span => span.status.code), ownCodes: own.map(span => span.attributes['mikka.error.code']), parentStatus: parent.status.code, failed: lines[0].failed,
        errorLogs: logMemory.getFinishedLogRecords().filter(record => record.body === 'mikka.stage.failed' && record.attributes['mikka.error.code'] === code).length })
    }
    assert.ok(observations.every(item => item.parentStatus === SpanStatusCode.OK), 'official Workflow preserves the returned-result step semantics')
    assert.ok(observations.every(item => item.ownStatuses.every(status => status === SpanStatusCode.ERROR)), 'the own phase and dispatch remain ERROR after the SDK marks its parent OK')
    assert.ok(observations.every(item => item.ownCodes.every(code => code === item.code)))
    assert.ok(observations.every(item => item.failed && item.errorLogs === 2))

    // A later successful request returns the same object and cannot inherit a refusal.
    memory.reset(); logMemory.reset()
    const success = { runId: 'same-success-object', get content(): never { throw new Error('UNREAD_CONTENT') } }, lines: DispatchTiming[] = []
    const result = await official.trace('step.execute successful repository fixture', () =>
      withDispatchTiming(() => withResolvedRepository('alex', ISSUE, 'Mikka_test', async () => success, lister(), noContext),
        Date.now, line => lines.push(line), async () => ({ workflowRunId: 'wrun_repository_success_fixture', stepId: 'step_fixture', attempt: 1 })))
    assert.equal(result, success)
    await provider.forceFlush(); await logs.forceFlush()
    assert.equal(lines[0].failed, false)
    assert.ok(memory.getFinishedSpans().every(span => span.status.code !== SpanStatusCode.ERROR && span.attributes['mikka.error.code'] === undefined))

    // A malformed host error preserves the old return contract but is not a
    // member of the closed repository telemetry code set.
    memory.reset(); logMemory.reset()
    const unknownLines: DispatchTiming[] = []
    const unknown = await withDispatchTiming(() => withResolvedRepository('alex', ISSUE, 'repository', async () => success,
      async () => { throw accessError('PRIVATE_UNKNOWN_CODE') }, noContext), Date.now, line => unknownLines.push(line),
      async () => ({ workflowRunId: 'wrun_repository_unknown_fixture', stepId: 'step_fixture', attempt: 1 }))
    assert.deepEqual(unknown, { error: 'PRIVATE_UNKNOWN_CODE', repository: 'repository', issueId: ISSUE })
    await provider.forceFlush(); await logs.forceFlush()
    assert.equal(unknownLines[0].failed, false)
    assert.doesNotMatch(JSON.stringify(memory.getFinishedSpans().map(span => span.attributes)), /PRIVATE_UNKNOWN_CODE/)
  } finally {
    await provider.shutdown(); await logs.shutdown()
    trace.disable(); context.disable(); propagation.disable()
  }
})

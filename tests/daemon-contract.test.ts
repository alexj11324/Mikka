// The oldest daemon the server serves (MIN_DAEMON_VERSION) is kept as released
// code in tests/fixtures/daemon-<version>/ (scripts/daemon-contract-fixture.mjs).
// Its git credential helper must accept today's run GitHub token answer; its
// HTTP client runs against today's routes in tests/daemon-contract.db.test.ts.
// Raising MIN_DAEMON_VERSION without refreshing the fixture fails here.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MIN_DAEMON_VERSION } from '@mikka/protocol/device'
import { createRunGitHubTokenExchange } from '../lib/github/run-token-exchange'
import { DAEMON_FIXTURE } from './support/daemon-fixture'


test('the fixture is the unedited npm release of MIN_DAEMON_VERSION', async () => {
  const release = JSON.parse(await readFile(join(DAEMON_FIXTURE, 'release.json'), 'utf8').catch(() => {
    throw new Error(`No fixture for MIN_DAEMON_VERSION ${MIN_DAEMON_VERSION}: run node scripts/daemon-contract-fixture.mjs ${MIN_DAEMON_VERSION}`)
  }))
  assert.equal(release.package, '@aspectlylabs/mikka')
  assert.equal(release.version, MIN_DAEMON_VERSION)
  assert.deepEqual(Object.keys(release.files).sort(), ['github-credentials.mjs', 'http-link.js'])
  for (const [file, sha256] of Object.entries(release.files))
    assert.equal(createHash('sha256').update(await readFile(join(DAEMON_FIXTURE, file))).digest('hex'), sha256, `${file} was edited`)
})

test('the oldest daemon\'s git credential helper accepts today\'s run GitHub token answer', async () => {
  const helper = await import(join(DAEMON_FIXTURE, 'github-credentials.mjs')) as { getRunGitHubToken(config: Record<string, string>, options: { fetcher: typeof fetch; now: () => number }): Promise<string> }
  const now = Date.parse('2026-11-02T00:00:00Z')
  const handle = createRunGitHubTokenExchange({
    authorize: async () => ({ runId: 'run-one', userId: 'owner', remoteKey: 'v2/github.com/owner/repo' }), now: () => now,
    issue: async () => ({ token: 'synthetic-user-token', expiresAt: new Date(now + 8 * 60 * 60_000) }),
  })
  const directory = await mkdtemp(join(tmpdir(), 'daemon-contract-'))
  try {
    const config = { file: join(directory, 'config.json'), endpoint: 'https://mikka.example/api/runs/github-token', runToken: 'synthetic-run-token', repository: 'owner/repo' }
    await writeFile(config.file, JSON.stringify(config), { mode: 0o600 })
    const fetcher = (async (url: string, init: RequestInit) => handle(new Request(url, init))) as typeof fetch
    assert.equal(await helper.getRunGitHubToken(config, { fetcher, now: () => now }), 'synthetic-user-token')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

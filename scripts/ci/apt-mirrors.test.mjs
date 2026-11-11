import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareAptMirrors, skipAzureMirror } from './apt-mirrors.mjs'

const azure = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n'
const fallback = 'https://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n'

test('only the failing Azure preference is removed; official fallback bytes and order are retained', () => {
  assert.equal(skipAzureMirror(azure + fallback), fallback)
  assert.equal(skipAzureMirror(azure.replace('http:', 'https:') + fallback), fallback)
  assert.equal(skipAzureMirror((azure + fallback).replaceAll('\n', '\r\n')), fallback.replaceAll('\n', '\r\n'))
  assert.equal(skipAzureMirror(fallback), fallback)
  assert.equal(skipAzureMirror(skipAzureMirror(azure + fallback)), fallback)
})

test('a missing official fallback fails before an Azure-only or private mirror list can be emptied', () => {
  for (const source of [azure, azure + '# https://archive.ubuntu.com/ubuntu/\n', azure + 'https://private.invalid/ubuntu/\n'])
    assert.throws(() => skipAzureMirror(source), /ci_apt_official_fallback_missing/)
})

test('comments, lookalike domains and other configured mirrors are never rewritten', () => {
  const unchanged = '# ' + azure + 'https://azure.archive.ubuntu.com.evil.invalid/ubuntu/\nhttps://private.invalid/ubuntu/\n'
  assert.equal(skipAzureMirror(unchanged), unchanged)
  assert.equal(skipAzureMirror(azure + fallback + unchanged), fallback + unchanged)
})

test('actual file preparation is idempotent, preserves mode, and missing-list runners remain supported', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-ci-apt-'))
  try {
    const file = join(directory, 'apt-mirrors.txt'), unrelated = join(directory, 'ubuntu.sources')
    const signedSource = 'URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-security\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
    await writeFile(file, azure + fallback); await chmod(file, 0o640); await writeFile(unrelated, signedSource)
    assert.deepEqual(await prepareAptMirrors(file), { changed: true, reason: 'azure_mirror_removed' })
    assert.equal(await readFile(file, 'utf8'), fallback)
    assert.equal((await stat(file)).mode & 0o777, 0o640)
    assert.equal(await readFile(unrelated, 'utf8'), signedSource)
    assert.deepEqual(await prepareAptMirrors(file), { changed: false, reason: 'already_prepared' })
    assert.deepEqual(await prepareAptMirrors(join(directory, 'missing')), { changed: false, reason: 'mirror_list_absent' })
    await writeFile(file, azure)
    await assert.rejects(prepareAptMirrors(file), /ci_apt_official_fallback_missing/)
    assert.equal(await readFile(file, 'utf8'), azure)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('the real CLI reports only its closed outcome, not configured mirror contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-ci-apt-cli-'))
  try {
    const file = join(directory, 'apt-mirrors.txt')
    await writeFile(file, azure + fallback + 'https://private.invalid/DO_NOT_LOG_THIS\n')
    const output = execFileSync(process.execPath, [new URL('./apt-mirrors.mjs', import.meta.url).pathname, file], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(output), { event: 'ci_apt_mirrors', changed: true, reason: 'azure_mirror_removed' })
    assert.ok(!output.includes('DO_NOT_LOG_THIS'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('all three affected jobs prepare mirrors before unchanged native dependency installation', async () => {
  for (const file of ['desktop.yml', 'analytics-ssr.yml', 'unattended-sandbox.yml']) {
    const source = await readFile(new URL('../../.github/workflows/' + file, import.meta.url), 'utf8')
    const prepare = source.indexOf('sudo "$(command -v node)" scripts/ci/apt-mirrors.mjs')
    assert.ok(prepare >= 0 && prepare < source.indexOf('pnpm exec playwright install --with-deps chromium'), file)
    assert.ok(!source.slice(prepare, source.indexOf('pnpm exec playwright install --with-deps chromium')).includes('continue-on-error'), file)
  }
  const tasks = await readFile(new URL('./tasks.json', import.meta.url), 'utf8')
  assert.ok(tasks.includes('node --test scripts/ci/*.test.mjs'), 'the existing CI inventory executes these offline guards')
})

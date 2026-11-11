import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareAptMirrors, prepareMirrorList, ubuntuHttpsMirror } from './apt-mirrors.mjs'

const azure = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n'
const fallback = 'https://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n'
const preferred = ubuntuHttpsMirror + '\tpriority:1\n'

test('a registered independent HTTPS mirror is preferred while official fallback bytes and order are retained', () => {
  assert.equal(prepareMirrorList(azure + fallback), preferred + fallback)
  assert.equal(prepareMirrorList(azure.replace('http:', 'https:') + fallback), preferred + fallback)
  assert.equal(prepareMirrorList((azure + fallback).replaceAll('\n', '\r\n')), (preferred + fallback).replaceAll('\n', '\r\n'))
  assert.equal(prepareMirrorList(fallback), preferred + fallback)
  assert.equal(prepareMirrorList(prepareMirrorList(azure + fallback)), preferred + fallback)
  assert.equal(prepareMirrorList(ubuntuHttpsMirror + '\tpriority:5\n' + fallback), preferred + fallback)
})

test('a missing official fallback fails before an Azure-only or private mirror list can be emptied', () => {
  for (const source of [azure, azure + '# https://archive.ubuntu.com/ubuntu/\n', azure + 'https://private.invalid/ubuntu/\n'])
    assert.throws(() => prepareMirrorList(source), /ci_apt_official_fallback_missing/)
})

test('comments, lookalike domains and other configured mirrors are never rewritten', () => {
  const unchanged = '# ' + azure + 'https://azure.archive.ubuntu.com.evil.invalid/ubuntu/\nhttps://private.invalid/ubuntu/\n'
  assert.equal(prepareMirrorList(unchanged), unchanged)
  assert.equal(prepareMirrorList(azure + fallback + unchanged), preferred + fallback + unchanged)
  const lookalike = 'https://mirror.umd.edu.evil.invalid/ubuntu/\tpriority:1\n'
  assert.equal(prepareMirrorList(fallback + lookalike), preferred + fallback + lookalike)
})

test('actual file preparation is idempotent, preserves mode, and missing-list runners remain supported', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-ci-apt-'))
  try {
    const file = join(directory, 'apt-mirrors.txt'), unrelated = join(directory, 'ubuntu.sources')
    const signedSource = 'URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-security\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n'
    await writeFile(file, azure + fallback); await chmod(file, 0o640); await writeFile(unrelated, signedSource)
    assert.deepEqual(await prepareAptMirrors(file), { changed: true, reason: 'independent_https_mirror_preferred' })
    assert.equal(await readFile(file, 'utf8'), preferred + fallback)
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
    assert.deepEqual(JSON.parse(output), { event: 'ci_apt_mirrors', changed: true, reason: 'independent_https_mirror_preferred' })
    assert.ok(!output.includes('DO_NOT_LOG_THIS'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('every workflow APT callsite has mirror preparation in the same Linux job after checkout and Node', async () => {
  const root = new URL('../../.github/workflows/', import.meta.url), covered = new Set()
  const pnpm = await readFile(new URL('../../.github/actions/pnpm-install/action.yml', import.meta.url), 'utf8')
  assert.match(pnpm, /uses: actions\/setup-node@/, 'the composite dependency action also prepares Node')
  for (const file of (await readdir(root)).filter(file => /\.ya?ml$/.test(file))) {
    const source = await readFile(new URL(file, root), 'utf8')
    const jobs = [...source.matchAll(/^  ([\w-]+):\s*$/gm)]
    for (const [index, start] of jobs.entries()) {
      const job = source.slice(start.index, jobs[index + 1]?.index ?? source.length)
      if (!job.includes('\n    steps:')) continue
      const boundaries = [...job.matchAll(/^      - .+$/gm)]
      const prepared = [], checkedOut = [], nodeReady = []
      for (const [stepIndex, boundary] of boundaries.entries()) {
        const step = job.slice(boundary.index, boundaries[stepIndex + 1]?.index ?? job.length)
        const guard = /^        if: (.+)$/m.exec(step)?.[1] ?? ''
        const available = entries => entries.some(entry => !entry || entry === guard)
        const priorPreparation = available(prepared)
        if (/uses: actions\/checkout@/.test(step)) checkedOut.push(guard)
        if (/uses: (?:actions\/setup-node@|\.\/\.github\/actions\/pnpm-install)/.test(step)) nodeReady.push(guard)
        if (step.includes('sudo "$(command -v node)" scripts/ci/apt-mirrors.mjs')) {
          assert.match(job, /^    runs-on: ubuntu-/m, `${file}/${start[1]} must prepare mirrors only on Linux`)
          assert.ok(available(checkedOut) && available(nodeReady), `${file}/${start[1]} requires checkout and Node before mirror preparation`)
          prepared.push(guard)
        }
        const commands = step.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
        const install = /\bapt-get\s|\bsudo apt\s|\bplaywright (?:install[^\n]*--with-deps|install-deps)\b/.exec(commands)
        if (!install) continue
        const sameStepPreparation = commands.indexOf('sudo "$(command -v node)" scripts/ci/apt-mirrors.mjs')
        assert.ok(priorPreparation || sameStepPreparation >= 0 && sameStepPreparation < install.index,
          `${file}/${start[1]} has an unprepared APT callsite or a mismatched conditional`)
        covered.add(file)
      }
    }
  }
  for (const file of ['desktop.yml', 'analytics-ssr.yml', 'unattended-sandbox.yml',
    'self-hosted-image.yml', 'run-trace-acceptance.yml', 'self-hosting-ui.yml', 'cloud-computer.yml',
    'read-cache-production.yml', 'issue1415-deployed-production.yml', 'ui-policy.yml']) assert.ok(covered.has(file), file)
  const tasks = await readFile(new URL('./tasks.json', import.meta.url), 'utf8')
  assert.ok(tasks.includes('node --test scripts/ci/*.test.mjs'), 'the existing CI inventory executes these offline guards')
})

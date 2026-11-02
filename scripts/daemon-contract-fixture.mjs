// Refreshes tests/fixtures/daemon-<version>/ from the npm release named by
// MIN_DAEMON_VERSION: the released HTTP client and git credential helper,
// unedited, which tests/daemon-contract*.test.ts run against today's server.
//
//   node scripts/daemon-contract-fixture.mjs 0.0.299
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('usage: node scripts/daemon-contract-fixture.mjs <version>')
const name = '@aspectlylabs/mikka'
const FILES = ['http-link.js', 'github-credentials.mjs']
const work = mkdtempSync(join(tmpdir(), 'daemon-contract-'))
try {
  const meta = JSON.parse(execFileSync('npm', ['view', `${name}@${version}`, 'dist', '--json'], { encoding: 'utf8' }))
  const tarball = join(work, execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], { cwd: work, encoding: 'utf8' }).trim())
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
  if (integrity !== meta.integrity) throw new Error('npm tarball integrity mismatch')
  execFileSync('tar', ['xzf', tarball, '-C', work])
  const target = join('tests', 'fixtures', `daemon-${version}`)
  mkdirSync(target, { recursive: true })
  const files = {}
  for (const file of FILES) {
    const body = readFileSync(join(work, 'package', file))
    writeFileSync(join(target, file), body)
    files[file] = createHash('sha256').update(body).digest('hex')
  }
  writeFileSync(join(target, 'release.json'), `${JSON.stringify({ package: name, version, integrity, files }, null, 2)}\n`)
  console.log(`wrote ${target}; point tests/daemon-contract*.test.ts at it and remove the previous fixture`)
} finally { rmSync(work, { recursive: true, force: true }) }

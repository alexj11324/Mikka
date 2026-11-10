import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, copyFile, readdir, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const installed = dirname(require.resolve('ffmpeg-static/package.json'))
const source = process.env.FFMPEG_INSTALL_TEST_PACKAGE || installed
const assetRoot = process.env.FFMPEG_INSTALL_TEST_ASSETS || installed
const manifestSource = process.env.FFMPEG_INSTALL_TEST_MANIFEST || join(source, 'mikka-assets.json')
const sha = data => createHash('sha256').update(data).digest('hex')
const binary = await readFile(join(assetRoot, 'ffmpeg'))
const readme = await readFile(join(assetRoot, 'ffmpeg.README'))
const license = await readFile(join(assetRoot, 'ffmpeg.LICENSE'))
const manifest = JSON.parse(await readFile(manifestSource, 'utf8'))
// Reuse the real installed executable and metadata. The integration run also
// supplies the original pinned release gzip, without another external GET.
const gzip = process.env.FFMPEG_INSTALL_TEST_GZIP
  ? await readFile(process.env.FFMPEG_INSTALL_TEST_GZIP) : gzipSync(binary)
const platform = process.platform + '-' + process.arch
const binName = 'ffmpeg-' + platform
assert.equal(sha(binary), manifest.assets[binName].sha256)
assert.equal(sha(readme), manifest.assets[platform + '.README'].sha256)
assert.equal(sha(license), manifest.assets[platform + '.LICENSE'].sha256)
if (process.env.FFMPEG_INSTALL_TEST_GZIP) assert.equal(sha(gzip), manifest.assets[binName + '.gz'].sha256)
else manifest.assets[binName + '.gz'] = { ...manifest.assets[binName + '.gz'], size: gzip.length, sha256: sha(gzip) }
const preload = "\nconst https = require('node:https')\nconst http = require('node:http')\nconst fs = require('node:fs')\nconst { Readable } = require('node:stream')\nhttps.get = (url, options, callback) => {\n  const original = new URL(url)\n  if (original.hostname !== 'github.com' && original.hostname !== 'api.github.com' && original.hostname !== 'release-assets.githubusercontent.com') {\n    throw new Error('Unexpected network destination in offline installation test')\n  }\n  return http.get(process.env.FFMPEG_TEST_SERVER + '/?url=' + encodeURIComponent(original.href),\n    { ...options, agent: false }, callback)\n}\nif (process.env.FFMPEG_TEST_FAILURE === 'write') {\n  const create = fs.createWriteStream\n  fs.createWriteStream = (file, options) => String(file).endsWith('/download')\n    ? create('/dev/full', { flags: 'w' }) : create(file, options)\n}\nif (process.env.FFMPEG_TEST_FAILURE === 'gunzip') {\n  const create = fs.createReadStream\n  const reads = new Map()\n  fs.createReadStream = (file, options) => {\n    if (String(file).endsWith('/download')) {\n      const count = (reads.get(file) || 0) + 1\n      reads.set(file, count)\n      if (count === 2) return Readable.from([Buffer.from('invalid gzip after a verified download')])\n    }\n    return create(file, options)\n  }\n}\n"

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-ffmpeg-install-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const file of ['install.js', 'index.js', 'package.json', 'mikka-install.js']) {
    try { await copyFile(join(source, file), join(directory, file)) }
    catch (error) { if (file !== 'mikka-install.js' || error.code !== 'ENOENT') throw error }
  }
  await writeFile(join(directory, 'mikka-assets.json'), JSON.stringify(manifest))
  await writeFile(join(directory, 'preload.cjs'), preload)
  const binaryPath = join(directory, 'ffmpeg')
  if (options.binary === 'valid') await copyFile(join(assetRoot, 'ffmpeg'), binaryPath)
  if (options.binary === 'partial') await writeFile(binaryPath, binary.subarray(0, 8192))
  if (options.readme) await copyFile(join(assetRoot, 'ffmpeg.README'), binaryPath + '.README')
  if (options.license) await copyFile(join(assetRoot, 'ffmpeg.LICENSE'), binaryPath + '.LICENSE')
  const requests = [], closed = [], sockets = new Set()
  const assets = new Map([
    [binName + '.gz', gzip], [platform + '.README', readme], [platform + '.LICENSE', license],
  ])
  const server = createServer((req, res) => {
    const original = new URL(new URL(req.url, 'http://local').searchParams.get('url'))
    const api = original.hostname === 'api.github.com'
    const tail = original.pathname.split('/').pop()
    const name = api ? Object.entries(manifest.assets).find(([, a]) => String(a.id) === tail)?.[0] : tail
    requests.push({ name, api, host: original.hostname, path: original.pathname, query: original.search, authorization: req.headers.authorization ?? null, at: Date.now(), encoding: req.headers['accept-encoding'], accept: req.headers.accept })
    const data = assets.get(name)
    if (!data) { res.writeHead(404); res.end(); return }
    if (options.authCase && name === platform + '.LICENSE') {
      const apiUrl = 'https://api.github.com/repos/eugeneware/ffmpeg-static/releases/assets/' + manifest.assets[name].id
      if (original.hostname === 'github.com') {
        res.writeHead(options.releaseToApi ? 302 : 504, options.releaseToApi ? { location: apiUrl } : {})
        res.end(); return
      }
      if (original.href === apiUrl) {
        if (options.authReject) { res.writeHead(403); res.end('DO_NOT_LOG_AUTH_RESPONSE'); return }
        if (options.authRedirect) {
          const target = options.authRedirect === 'cdn'
            ? 'https://release-assets.githubusercontent.com/assets/' + name + '?signed=DO_NOT_LOG_CDN'
            : options.authRedirect === 'path'
              ? 'https://api.github.com/other/' + manifest.assets[name].id
              : apiUrl + '?query=DO_NOT_LOG_QUERY'
          res.writeHead(302, { location: target }); res.end(); return
        }
      }
    }
    if (options.diagnostics && name === platform + '.LICENSE') {
      if (!api && original.hostname === 'github.com' && !options.invalidHeaders) {
        res.writeHead(302, { location: 'https://release-assets.githubusercontent.com/private/' + name + '?signed=DO_NOT_LOG_SIGNED_QUERY' })
        res.end(); return
      }
      res.writeHead(api ? 403 : 504, {
        'x-ratelimit-remaining': options.invalidHeaders ? 'DO_NOT_LOG_HEADER' : api ? '0' : '7',
        'x-ratelimit-reset': options.invalidHeaders ? 'https://private.invalid/reset' : '1794211200',
        'retry-after': options.invalidHeaders ? 'https://private.invalid/retry?token=DO_NOT_LOG_RETRY' : api ? '60' : 'Mon, 09 Nov 2026 08:00:00 GMT',
        'x-private-diagnostic': 'DO_NOT_LOG_ARBITRARY_HEADER',
      })
      res.end('DO_NOT_LOG_RESPONSE_BODY'); return
    }
    if (options.stall) {
      res.writeHead(200); res.flushHeaders()
      res.on('close', () => closed.push(name))
      return
    }
    if (options.redirect) {
      res.writeHead(302, { location: original.href }); res.end(); return
    }
    if (options.failBoth === name || (options.primary504 && !api)) {
      res.writeHead(504); res.end('upstream timeout'); return
    }
    res.writeHead(200, { 'content-length': data.length })
    if (options.truncate && name === binName + '.gz') {
      res.write(data.subarray(0, 8192))
      setImmediate(() => res.destroy())
      return
    }
    if (options.corrupt === name) {
      const corrupted = Buffer.from(data); corrupted[0] ^= 1; res.end(corrupted); return
    }
    res.end(data)
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const env = {
    ...process.env, NODE_PATH: dirname(installed),
    HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '',
    FFMPEG_BINARY_RELEASE: '', FFMPEG_BINARIES_URL: '', FFMPEG_BIN: '', FFMPEG_GITHUB_TOKEN: '',
    npm_config_arch: process.arch, npm_config_platform: process.platform,
    FFMPEG_TEST_SERVER: 'http://127.0.0.1:' + server.address().port,
    FFMPEG_TEST_FAILURE: options.failure || '',
  }
  async function run(entry = 'install.js') {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', join(directory, 'preload.cjs'), join(directory, entry)],
        { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal, output }))
    })
  }
  async function cleanTemps() {
    assert.equal((await readdir(directory)).some(name => name.startsWith('.ffmpeg-install-')), false)
  }
  async function complete() {
    assert.equal(sha(await readFile(binaryPath)), sha(binary))
    assert.equal(sha(await readFile(binaryPath + '.README')), sha(readme))
    assert.equal(sha(await readFile(binaryPath + '.LICENSE')), sha(license))
    await cleanTemps()
  }
  return { directory, binaryPath, requests, closed, run, cleanTemps, complete, options, env }
}

test('repairs binary-only installations with the real README and LICENSE', async t => {
  const f = await fixture(t, { binary: 'valid' })
  assert.equal((await f.run()).code, 0)
  await f.complete()
  assert.deepEqual(f.requests.map(r => r.name), [platform + '.README', platform + '.LICENSE'])
})

test('replaces a partial executable and verifies the complete bundle', async t => {
  const f = await fixture(t, { binary: 'partial' })
  assert.equal((await f.run()).code, 0)
  await f.complete()
  assert.equal(f.requests.length, 3)
})

test('a complete verified bundle performs no network requests', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, license: true })
  assert.equal((await f.run()).code, 0)
  await f.complete()
  assert.equal(f.requests.length, 0)
})

test('each primary 504 uses one pinned API fallback and the same real bytes', async t => {
  const f = await fixture(t, { primary504: true })
  assert.equal((await f.run()).code, 0)
  await f.complete()
  assert.deepEqual(f.requests.map(r => r.api), [false, true, false, true, false, true])
  assert.ok(f.requests.every(r => r.encoding === 'identity' && r.accept === 'application/octet-stream'))
})

test('a failed LICENSE stays failed, cleans temporary files, and repairs on retry', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, failBoth: platform + '.LICENSE' })
  const first = await f.run()
  assert.equal(first.code, 1)
  assert.match(first.output, /Could not install verified ffmpeg asset/)
  await assert.rejects(readFile(f.binaryPath + '.LICENSE'), { code: 'ENOENT' })
  await f.cleanTemps()
  assert.equal(f.requests.length, 2)
  f.options.failBoth = null
  assert.equal((await f.run()).code, 0)
  await f.complete()
  assert.equal(f.requests.length, 3)
})

test('truncated download streams fail without publishing a partial binary', async t => {
  const f = await fixture(t, { truncate: true })
  assert.equal((await f.run()).code, 1)
  await assert.rejects(readFile(f.binaryPath), { code: 'ENOENT' })
  await f.cleanTemps()
  assert.equal(f.requests.length, 2)
})

test('real gunzip failure cleans unpublished files and remains an error', async t => {
  const f = await fixture(t, { failure: 'gunzip' })
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /incorrect header check/)
  await assert.rejects(readFile(f.binaryPath), { code: 'ENOENT' })
  await f.cleanTemps()
  assert.equal(f.requests.length, 2)
})

test('real ENOSPC aborts the download and does not retry a filesystem failure', async t => {
  const f = await fixture(t, { failure: 'write' })
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /ENOSPC/)
  await f.cleanTemps()
  assert.equal(f.requests.length, 1)
})

test('rename failure preserves the existing directory and cleans staging', async t => {
  const f = await fixture(t)
  await mkdir(f.binaryPath)
  await writeFile(join(f.binaryPath, 'keep'), 'owned')
  assert.equal((await f.run()).code, 1)
  assert.equal(await readFile(join(f.binaryPath, 'keep'), 'utf8'), 'owned')
  await f.cleanTemps()
  assert.equal(f.requests.length, 1)
})

test('redirect loops stop after three redirects for each fixed source', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, redirect: true })
  assert.equal((await f.run()).code, 1)
  await f.cleanTemps()
  assert.equal(f.requests.length, 8)
})

test('the real 30 second deadline cancels a response stalled after headers', { timeout: 75_000 }, async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, stall: true })
  const started = Date.now()
  const result = await f.run()
  const elapsed = Date.now() - started
  assert.equal(result.code, 1)
  assert.equal(f.requests.length, 2)
  assert.equal(f.closed.length, 2)
  assert.ok(elapsed >= 59_000 && elapsed < 70_000, 'two real bounded attempts: ' + elapsed)
  await f.cleanTemps()
})

test('same-size corrupted LICENSE is repaired instead of passing the completeness check', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, license: true })
  const corrupted = Buffer.from(license)
  corrupted[0] ^= 1
  await writeFile(f.binaryPath + '.LICENSE', corrupted)
  assert.equal((await f.run()).code, 0)
  await f.complete()
  assert.deepEqual(f.requests.map(r => r.name), [platform + '.LICENSE'])
})

test('a full-size bad asset digest fails both sources without publishing metadata', async t => {
  const f = await fixture(t, { binary: 'valid', license: true, corrupt: platform + '.README' })
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /asset integrity mismatch/)
  await assert.rejects(readFile(f.binaryPath + '.README'), { code: 'ENOENT' })
  await f.cleanTemps()
  assert.equal(f.requests.length, 2)
})

test('an explicit external binary path is rejected without rewriting its bytes', async t => {
  const f = await fixture(t)
  const external = join(f.directory, 'operator-owned-binary')
  await writeFile(external, 'operator-owned executable')
  f.env.FFMPEG_BIN = external
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /cannot rewrite a custom binary path/)
  assert.equal(await readFile(external, 'utf8'), 'operator-owned executable')
  assert.equal(f.requests.length, 0)
  await f.cleanTemps()
})


function failureRecord(output) {
  const line = output.split('\n').find(line => line.startsWith('{"message":'))
  assert.ok(line, 'launcher must emit the safe structured failure record')
  return JSON.parse(line)
}

test('failed official sources retain independent status and final-hop diagnostics', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, diagnostics: true })
  const result = await f.run()
  assert.equal(result.code, 1)
  const record = failureRecord(result.output)
  assert.equal(record.message, 'Could not install verified ffmpeg asset ' + platform + '.LICENSE')
  assert.equal(record.asset, platform + '.LICENSE')
  assert.deepEqual(record.attempts.map(({ elapsedMs, ...attempt }) => {
    assert.ok(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0)
    return attempt
  }), [
    { source: 'release', host: 'release-assets', redirects: 1, phase: 'response',
      reason: 'http', status: 504, code: null, detail: null, rateLimitRemaining: 7,
      rateLimitReset: 1794211200, retryAfter: 'Mon, 09 Nov 2026 08:00:00 GMT' },
    { source: 'api', host: 'api', redirects: 0, phase: 'response',
      reason: 'http', status: 403, code: null, detail: null, rateLimitRemaining: 0,
      rateLimitReset: 1794211200, retryAfter: '60' },
  ])
  assert.deepEqual(f.requests.map(r => r.host), ['github.com', 'release-assets.githubusercontent.com', 'api.github.com'])
  assert.doesNotMatch(result.output, /DO_NOT_LOG|https?:\/\/|private|x-private-diagnostic/)
  await assert.rejects(readFile(f.binaryPath + '.LICENSE'), { code: 'ENOENT' })
  await f.cleanTemps()
})

test('failure diagnostics discard malformed rate headers and all response content', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, diagnostics: true, invalidHeaders: true })
  const result = await f.run()
  assert.equal(result.code, 1)
  const record = failureRecord(result.output)
  assert.deepEqual(record.attempts.map(a => [a.source, a.host, a.status, a.rateLimitRemaining, a.rateLimitReset, a.retryAfter]),
    [['release', 'release', 504, null, null, null], ['api', 'api', 403, null, null, null]])
  assert.doesNotMatch(result.output, /DO_NOT_LOG|https?:\/\/|private|x-private-diagnostic/)
  assert.equal(f.requests.length, 2)
  await f.cleanTemps()
})

test('aggregate errors retain caught causes internally while the launcher formatter excludes them', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, diagnostics: true, invalidHeaders: true })
  await writeFile(join(f.directory, 'observe-failure.cjs'), [
    "const assert = require('node:assert/strict')",
    "const fs = require('node:fs')",
    "const { install, formatInstallError } = require('./mikka-install')",
    "install().catch(error => {",
    "  assert.ok(error instanceof AggregateError)",
    "  assert.equal(error.errors.length, 2)",
    "  assert.equal(error.cause, error.errors[1])",
    "  for (const [index, attempt] of error.errors.entries()) {",
    "    assert.ok(attempt.cause instanceof Error)",
    "    assert.equal(attempt.cause.message, 'ffmpeg asset HTTP ' + [504, 403][index])",
    "  }",
    "  const raw = new Error('https://user:DO_NOT_LOG_PROXY@proxy.invalid/?signed=DO_NOT_LOG_QUERY', { cause: error })",
    "  raw.code = 'DO_NOT_LOG_CODE'",
    "  const formatted = formatInstallError(raw)",
    "  assert.doesNotMatch(formatted, /DO_NOT_LOG|proxy|https|504|403/)",
    "  assert.equal(raw.cause, error)",
    "  fs.writeFileSync('cause-proof.json', JSON.stringify({ aggregate: true, causes: 2, rawPreserved: true, formatted: JSON.parse(formatted) }))",
    "  console.error(formatInstallError(error))",
    "  process.exitCode = 1",
    "})",
  ].join('\n'))
  const result = await f.run('observe-failure.cjs')
  assert.equal(result.code, 1)
  const proof = JSON.parse(await readFile(join(f.directory, 'cause-proof.json'), 'utf8'))
  assert.deepEqual(proof, { aggregate: true, causes: 2, rawPreserved: true,
    formatted: { message: 'ffmpeg installation failed', code: null } })
  assert.equal(failureRecord(result.output).attempts.length, 2)
  assert.equal(f.requests.length, 2)
  await f.cleanTemps()
})


const syntheticApiToken = 'fixture_ffmpeg_api_token_DO_NOT_LOG'

test('optional API credentials are sent only on the fixed API entry request', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, authCase: true })
  f.env.FFMPEG_GITHUB_TOKEN = syntheticApiToken
  const result = await f.run()
  assert.equal(result.code, 0)
  await f.complete()
  assert.deepEqual(f.requests.map(r => [r.host, r.authorization]),
    [['github.com', null], ['api.github.com', 'Bearer ' + syntheticApiToken]])
  assert.equal(f.requests[1].path, '/repos/eugeneware/ffmpeg-static/releases/assets/' + manifest.assets[platform + '.LICENSE'].id)
  assert.equal(f.requests[1].query, '')
  assert.doesNotMatch(result.output, /fixture_ffmpeg|DO_NOT_LOG/)
})

test('API redirects drop credentials on CDN and same-host path or query changes', async t => {
  for (const target of ['cdn', 'path', 'query']) {
    await t.test(target, async t => {
      const f = await fixture(t, { binary: 'valid', readme: true, authCase: true, authRedirect: target })
      f.env.FFMPEG_GITHUB_TOKEN = syntheticApiToken
      const result = await f.run()
      assert.equal(result.code, 0)
      await f.complete()
      assert.deepEqual(f.requests.map(r => r.authorization), [null, 'Bearer ' + syntheticApiToken, null])
      assert.equal(f.requests.length, 3)
      assert.doesNotMatch(result.output, /fixture_ffmpeg|DO_NOT_LOG/)
    })
  }
})

test('release redirects never acquire optional credentials even at the pinned API URL', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, authCase: true, releaseToApi: true })
  f.env.FFMPEG_GITHUB_TOKEN = syntheticApiToken
  const result = await f.run()
  assert.equal(result.code, 0)
  await f.complete()
  assert.deepEqual(f.requests.map(r => [r.host, r.authorization]), [['github.com', null], ['api.github.com', null]])
})

test('without an explicit FFmpeg token the existing anonymous contract is unchanged', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, authCase: true })
  f.env.GITHUB_TOKEN = 'unrelated_synthetic_token_must_not_be_used'
  const result = await f.run()
  assert.equal(result.code, 0)
  await f.complete()
  assert.deepEqual(f.requests.map(r => r.authorization), [null, null])
  assert.equal(f.requests.length, 2)
})

test('API authentication rejection keeps the two-source budget and never leaks credentials', async t => {
  const f = await fixture(t, { binary: 'valid', readme: true, authCase: true, authReject: true })
  f.env.FFMPEG_GITHUB_TOKEN = syntheticApiToken
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.deepEqual(f.requests.map(r => r.authorization), [null, 'Bearer ' + syntheticApiToken])
  assert.deepEqual(failureRecord(result.output).attempts.map(a => [a.source, a.status]), [['release', 504], ['api', 403]])
  assert.doesNotMatch(result.output, /fixture_ffmpeg|DO_NOT_LOG|Bearer|Authorization/)
  await assert.rejects(readFile(f.binaryPath + '.LICENSE'), { code: 'ENOENT' })
  await f.cleanTemps()
  assert.equal(f.requests.length, 2)
})

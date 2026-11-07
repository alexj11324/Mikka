import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import { delimiter, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { execa } from 'execa'
import { afterEach, expect, it, vi } from 'vitest'
import { withRunGitCredentials } from '../src/agents/github-runtime'
import { RepositoryCache } from '../src/repositories'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(() => { vi.unstubAllEnvs(); cleanupTempDirs() })

const token = 'synthetic-prepared-github-token'
const authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
const remoteUrl = 'https://github.com/Owner/Repo.git'
const assignment = { issueId: 'prepared-token-fixture', remoteUrl,
  github: { endpoint: 'https://mikka.invalid/api/runs/github-token', repository: 'owner/repo', token } }

/** Real Git smart HTTP, routed entirely to loopback; no DNS or real credentials. */
async function fixture() {
  const root = tempDir(), source = await makeRepo(), home = join(root, 'home'), bin = join(root, 'bin')
  mkdirSync(home); mkdirSync(bin); mkdirSync(join(root, 'Owner'))
  execFileSync('git', ['clone', '--bare', source, join(root, 'Owner', 'Repo.git')], { stdio: 'ignore' })
  const ghCalled = join(root, 'gh-called')
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf invoked >> '${ghCalled}'\nexit 1\n`, { mode: 0o700 })
  writeFileSync(join(home, '.gitconfig'), '[mikka]\n\tfixture = original home\n')
  const key = join(root, 'key.pem'), cert = join(root, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-subj', '/CN=github.com', '-days', '1'], { stdio: 'ignore' })
  const requests: Array<{ host: string; path: string; authorization: string | undefined }> = []
  const sockets = new Set<Duplex>()
  const children = new Set<ReturnType<typeof spawn>>()
  let deny = false, redirect = ''
  const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
    const host = request.headers.host ?? '', url = new URL(request.url ?? '/', 'https://fixture.invalid')
    requests.push({ host, path: url.pathname, authorization: request.headers.authorization })
    const renamed = redirect === 'https://github.com/Other/Repo.git' && url.pathname.startsWith('/Other/Repo.git/')
    // A normal repository rename advertises its new URL before requiring
    // credentials. The separate cross-host case redirects after authentication.
    if (redirect === 'https://github.com/Other/Repo.git' && host === 'github.com' && !renamed) {
      response.writeHead(301, { location: `${redirect}${url.pathname.slice('/Owner/Repo.git'.length)}${url.search}` }).end()
      return
    }
    if (deny || (!url.pathname.startsWith('/Owner/Repo.git/') && !renamed)
      || host === 'github.com' && request.headers.authorization !== authorization) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="synthetic Git fixture"' }).end()
      return
    }
    if (redirect && host === 'github.com' && !renamed) {
      response.writeHead(301, { location: `${redirect}${url.pathname.slice('/Owner/Repo.git'.length)}${url.search}` }).end()
      return
    }
    const child = spawn('git', ['http-backend'], { env: { ...process.env,
      GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '', GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: request.method, PATH_INFO: renamed ? url.pathname.replace('/Other/', '/Owner/') : url.pathname, QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_USER: 'synthetic',
      HTTP_GIT_PROTOCOL: request.headers['git-protocol'] as string ?? '',
    }, stdio: ['pipe', 'pipe', 'ignore'] })
    children.add(child)
    child.on('close', () => { children.delete(child); response.end() })
    child.on('error', () => { response.writeHead(500).end() })
    let headers = Buffer.alloc(0), sentHeaders = false
    child.stdout!.on('data', (chunk: Buffer) => {
      if (sentHeaders) { response.write(chunk); return }
      headers = Buffer.concat([headers, chunk])
      const end = headers.indexOf('\r\n\r\n')
      if (end < 0) return
      let status = 200
      for (const line of headers.subarray(0, end).toString().split('\r\n')) {
        const colon = line.indexOf(':')
        if (colon < 0) continue
        const name = line.slice(0, colon), value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === 'status') status = Number(value.slice(0, 3))
        else response.setHeader(name, value)
      }
      response.writeHead(status); sentHeaders = true
      response.write(headers.subarray(end + 4)); headers = Buffer.alloc(0)
    })
    request.pipe(child.stdin!)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing HTTPS fixture')
  const proxy = createHttpServer((_request, response) => response.writeHead(400).end())
  proxy.on('connect', (request, socket, head) => {
    if (!['github.com:443', 'elsewhere.invalid:443'].includes(request.url ?? '')) { socket.destroy(); return }
    const upstream = connect(address.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    sockets.add(upstream); sockets.add(socket)
    upstream.on('close', () => { sockets.delete(upstream); socket.destroy() })
    socket.on('close', () => { sockets.delete(socket); upstream.destroy() })
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyAddress = proxy.address()
  if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('Missing CONNECT fixture')
  const env = { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_COUNT: '0', GIT_CONFIG_PARAMETERS: '',
    GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSL_NO_VERIFY: '1', GIT_TERMINAL_PROMPT: '0',
    HTTPS_PROXY: `http://127.0.0.1:${proxyAddress.port}`, https_proxy: `http://127.0.0.1:${proxyAddress.port}`,
    HTTP_PROXY: '', http_proxy: '', ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: '' }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  return { root, source, home, requests, ghCalled, env,
    deny: () => { deny = true }, redirect: (target = 'https://elsewhere.invalid/Owner/Repo.git') => { redirect = target },
    async close() {
      for (const child of children) child.kill('SIGTERM')
      for (const socket of sockets) socket.destroy()
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))])
    },
  }
}

it.each([false, true])('uses the already prepared claim token with real Git and preserves caller configuration (parameters=%s)', async parameters => {
  const f = await fixture()
  const cache = new RepositoryCache(join(f.root, 'clones'))
  vi.stubEnv('GIT_CONFIG_COUNT', '2')
  vi.stubEnv('GIT_CONFIG_KEY_0', 'mikka.counted'); vi.stubEnv('GIT_CONFIG_VALUE_0', 'keep counted')
  vi.stubEnv('GIT_CONFIG_KEY_1', 'credential.https://github.com.helper'); vi.stubEnv('GIT_CONFIG_VALUE_1', '!gh auth git-credential')
  if (parameters) vi.stubEnv('GIT_CONFIG_PARAMETERS', `'mikka.parameter=keep spaces and '\\''quotes'\\''' 'credential.https://github.com.helper=!gh auth git-credential'`)
  try {
    await withRunGitCredentials(assignment, join(f.root, 'private'), async env => {
      const config = (key: string) => execa('git', ['config', '--get', key], { env: { ...process.env, ...env } }).then(result => result.stdout)
      expect(await config('mikka.fixture')).toBe('original home')
      expect(await config('mikka.counted')).toBe('keep counted')
      if (parameters) expect(await config('mikka.parameter')).toBe("keep spaces and 'quotes'")
      const path = await cache.prepare(remoteUrl, undefined, env)
      expect((await execa('git', ['rev-parse', 'origin/main'], { cwd: path })).stdout)
        .toBe((await execa('git', ['rev-parse', 'main'], { cwd: f.source })).stdout)
      // The same prepared token also works for a later fetch without invoking gh.
      await cache.prepare(remoteUrl, undefined, env)
      const persisted = readFileSync(join(path, '.git', 'config'), 'utf8')
      expect(persisted).not.toContain(token); expect(persisted).not.toContain(authorization)
      expect(persisted).toContain(remoteUrl)
    })
    expect(f.requests.length).toBeGreaterThan(1)
    expect(f.requests.some(request => request.authorization === authorization)).toBe(true)
    expect(f.requests.every(request => request.authorization === undefined || request.authorization === authorization)).toBe(true)
    expect(existsSync(f.ghCalled)).toBe(false)
    expect(readFileSync(join(f.home, '.gitconfig'), 'utf8')).toBe('[mikka]\n\tfixture = original home\n')
    expect(existsSync(join(f.root, 'private'))).toBe(false)
  } finally { await f.close() }
})

it('keeps the existing GitHub host credential scope and excludes other hosts', async () => {
  const f = await fixture()
  try {
    await withRunGitCredentials(assignment, join(f.root, 'private'), async env => {
      for (const url of ['https://github.com/Other/Repo.git', 'https://github.com/Owner/Repo.git-more', 'https://elsewhere.invalid/Owner/Repo.git']) {
        await execa('git', ['ls-remote', url], { cwd: f.root, env: { ...process.env, ...env }, reject: false })
      }
    })
    expect(f.requests.length).toBeGreaterThanOrEqual(3)
    expect(f.requests.some(request => request.host === 'github.com' && request.authorization === authorization)).toBe(true)
    expect(f.requests.filter(request => request.host === 'elsewhere.invalid').every(request => request.authorization === undefined)).toBe(true)
  } finally { await f.close() }
})

it('never forwards the prepared Authorization to a redirect on another host', async () => {
  const f = await fixture()
  f.redirect()
  try {
    await withRunGitCredentials(assignment, join(f.root, 'private'), async env => {
      await new RepositoryCache(join(f.root, 'clones')).prepare(remoteUrl, undefined, env).catch(() => undefined)
    })
    expect(f.requests.some(request => request.host === 'github.com' && request.authorization === authorization)).toBe(true)
    expect(f.requests.some(request => request.host === 'elsewhere.invalid')).toBe(true)
    expect(f.requests.filter(request => request.host === 'elsewhere.invalid').every(request => request.authorization === undefined)).toBe(true)
  } finally { await f.close() }
})

it('preserves normal same-host repository rename redirects with standard Git credentials', async () => {
  const f = await fixture()
  f.redirect('https://github.com/Other/Repo.git')
  try {
    await withRunGitCredentials(assignment, join(f.root, 'private'), async env => {
      const path = await new RepositoryCache(join(f.root, 'clones')).prepare(remoteUrl, undefined, env)
      expect((await execa('git', ['rev-parse', 'origin/main'], { cwd: path })).stdout)
        .toBe((await execa('git', ['rev-parse', 'main'], { cwd: f.source })).stdout)
    })
    const redirected = f.requests.filter(request => request.path.startsWith('/Other/'))
    expect(redirected.length).toBeGreaterThan(0)
    expect(redirected.some(request => request.authorization === authorization)).toBe(true)
  } finally { await f.close() }
})

it('keeps real authentication failure and removes its partial clone without invoking gh', async () => {
  const f = await fixture(), cache = new RepositoryCache(join(f.root, 'clones'))
  f.deny()
  try {
    await withRunGitCredentials(assignment, join(f.root, 'private'), async env => {
      await expect(cache.prepare(remoteUrl, undefined, env)).rejects.toMatchObject({ exitCode: 128 })
    })
    expect(f.requests.some(request => request.authorization === authorization)).toBe(true)
    expect(existsSync(cache.pathFor(remoteUrl))).toBe(false)
    expect(existsSync(f.ghCalled)).toBe(false)
  } finally { await f.close() }
})

it('preserves an already prepared local environment and the no-GitHub path', async () => {
  const prepared = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'local-native-helper' }
  expect(await withRunGitCredentials(assignment, tempDir(), async env => env, prepared)).toBe(prepared)
  expect(await withRunGitCredentials({ issueId: 'no-github' }, tempDir(), async env => env)).toEqual({})
})


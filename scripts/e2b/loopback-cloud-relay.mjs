import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { fixtureGitResponse, relayTarget } from './local-api-relay.mjs'

const blocked = new Set(['host', 'connection', 'transfer-encoding', 'content-length', 'content-encoding', 'keep-alive', 'set-cookie', 'cookie'])
const forwarded = new Set(['content-type', 'accept', 'user-agent', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id', 'git-protocol'])
const scopeFields = ['issueId', 'repository', 'branch']

/** A real TLS/HTTP relay for an owned local cloud worker. No external endpoint
 * or provider credential participates; the real server signs its run policy. */
export async function startLoopbackCloudRelay({ localOrigin, barePath, repoToken, observe = () => {} }) {
  const target = new URL(localOrigin)
  assert.ok(target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/' && !target.username && !target.password && !target.search && !target.hash)
  assert.match(repoToken, /^[A-Za-z0-9_-]{43}$/)
  const directory = await mkdtemp(join(tmpdir(), 'mikka-cloud-relay-'))
  const keyPath = join(directory, 'key.pem'), caPath = join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', caPath], { stdio: 'ignore' })
  const key = await readFile(keyPath), ca = await readFile(caPath)
  let origin, credential, boundDevice, mcp, completed = false, finish
  const done = new Promise(resolve => { finish = resolve })
  const server = createServer({ key, cert: ca }, async (request, response) => {
    try {
      const url = new URL(request.url, origin), bearer = request.headers.authorization
      const git = url.pathname.startsWith('/mikka/v1/git/core-loop.git/')
      const mcpRequest = request.url === '/mikka/api/mcp'
      const githubToken = request.url === '/mikka/api/runs/github-token'
      const liveScope = mcp && performance.now() < mcp.until
      if (request.headers.host !== new URL(origin).host || request.headers.cookie ||
        (git ? bearer !== `Bearer ${repoToken}` : mcpRequest || githubToken ? !liveScope || request.method !== 'POST' || bearer !== `Bearer ${mcp.token}` : !credential || bearer !== `Bearer ${credential}`)) {
        response.writeHead(401); response.end(); return
      }
      const parts = []; let size = 0
      for await (const part of request) { size += part.length; if (size > 16 * 1024 * 1024) throw Error('LOCAL_CLOUD_RELAY_BODY_LIMIT'); parts.push(part) }
      const body = Buffer.concat(parts)
      const boundMcp = mcp
      if (githubToken) {
        if (!mcp.scope) { response.writeHead(403); response.end(); return }
        let supplied
        try { supplied = JSON.parse(body.toString()) } catch { response.writeHead(400); response.end(); return }
        if (Object.keys(supplied ?? {}).sort().join(',') !== [...scopeFields].sort().join(',') || scopeFields.some(key => supplied[key] !== mcp.scope[key])) {
          response.writeHead(403); response.end(); return
        }
      }
      const fixtureRequest = { id: randomUUID(), origin, path: request.url, method: request.method,
        scope: git ? 'git' : mcpRequest || githubToken ? 'mcp' : 'device', headers: request.headers, body: body.toString('base64') }
      let upstream
      if (git) upstream = await fixtureGitResponse(fixtureRequest, { barePath, relayOrigin: origin })
      else {
        if (!githubToken) relayTarget(fixtureRequest, { localOrigin, relayOrigin: origin })
        const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => forwarded.has(name) || name.startsWith('x-mikka-')))
        // The compiled API accepts only its configured authority. The signed
        // HTTPS worker issuer comes from the operator-owned cloud_relays row,
        // never an untrusted Host or forwarded header.
        headers.host = target.host
        headers.authorization = `Bearer ${mcpRequest || githubToken ? mcp.token : credential}`
        upstream = await new Promise((resolve, reject) => {
          const outgoing = httpRequest({ hostname: target.hostname, port: target.port, path: request.url, method: request.method, headers }, incoming => {
            const copied = new Headers()
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) if (!blocked.has(incoming.rawHeaders[i].toLowerCase())) copied.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1])
            resolve(new Response([204, 205, 304].includes(incoming.statusCode) ? null : Readable.toWeb(incoming), { status: incoming.statusCode, headers: copied }))
          })
          outgoing.setTimeout(180_000, () => outgoing.destroy(Error('LOCAL_CLOUD_RELAY_UPSTREAM_TIMEOUT')))
          outgoing.once('error', reject); outgoing.end(body)
        })
      }
      if (url.pathname.endsWith('/claim') && upstream.ok) {
        const context = await upstream.json()
        assert.equal(context.policySnapshot?.payload?.issuer, `${origin}/mikka`, 'LOCAL_CLOUD_POLICY_ISSUER_MISMATCH')
        if (context.mcp) {
          assert.ok(!mcp || mcp.runId === context.runId, 'LOCAL_CLOUD_FOREIGN_MCP_RUN')
          const endpoint = new URL(context.mcp.url)
          assert.ok([localOrigin, origin].includes(endpoint.origin) && endpoint.pathname === '/mikka/api/mcp' && !endpoint.search && !endpoint.hash)
          mcp = { runId: context.runId, token: context.mcp.token, until: performance.now() + 900_000,
            ...(context.github ? { scope: { issueId: context.issueId, repository: context.github.repository, branch: context.github.branch } } : {}) }
          context.mcp.url = `${origin}/mikka/api/mcp`
          if (context.github) {
            const endpoint = new URL(context.github.endpoint)
            assert.ok([localOrigin, origin].includes(endpoint.origin) && endpoint.pathname === '/mikka/api/runs/github-token' && !endpoint.search && !endpoint.hash)
            context.github.endpoint = `${origin}/mikka/api/runs/github-token`
          }
        }
        upstream = Response.json(context)
        observe({ type: 'claim', issuer: `${origin}/mikka`, status: 200 })
      } else if (url.pathname.includes('/policy-snapshot') && upstream.ok) {
        const value = await upstream.clone().json()
        assert.equal(value.issuer ?? value.payload?.issuer, `${origin}/mikka`, 'LOCAL_CLOUD_POLICY_ISSUER_MISMATCH')
      } else if (githubToken) {
        const bytes = Buffer.from(await upstream.arrayBuffer())
        assert.ok(bytes.length <= 64 * 1024 && mcp === boundMcp && performance.now() < mcp.until, 'LOCAL_CLOUD_GITHUB_SCOPE_EXPIRED')
        upstream = new Response(bytes, { status: upstream.status, headers: upstream.headers })
      }
      response.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !blocked.has(name))))
      if (upstream.body) for await (const part of upstream.body) response.write(part)
      response.end()
      observe({ type: 'request', path: url.pathname, status: upstream.status })
      if (mcp && url.pathname.endsWith(`/runs/${mcp.runId}/complete`) && upstream.ok) { completed = true; mcp = undefined }
    } catch {
      if (!response.headersSent) response.writeHead(502)
      response.end()
      observe({ type: 'relay-error', code: 'LOCAL_CLOUD_RELAY_FAILED' })
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `https://127.0.0.1:${server.address().port}`
  return { origin, ca, caPath, directory, get completed() { return completed },
    async bindDevice(value, deviceId) { assert.ok(!boundDevice); assert.match(value, /^orv_[A-Za-z0-9_-]{43}$/); assert.match(deviceId, /^[a-f0-9-]{36}$/); assert.notEqual(value.slice(4), repoToken); credential = value; boundDevice = deviceId },
    done,
    async stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); finish() },
  }
}

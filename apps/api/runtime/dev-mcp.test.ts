import assert from 'node:assert/strict'
import { Agent } from 'node:http'
import { createConnection } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build, createDevServer, createNitro, prepare } from 'nitro/builder'
import type { RunAssignment } from '@mikka/protocol'
import { createRunMailbox } from '../../../packages/daemon/src/run-mailbox'
import { apiProxyOptions } from '../scripts/dev-http.mjs'
import { developmentWorkerReady } from '../scripts/dev.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const frontendRequire = createRequire(join(repository, 'apps/frontend/package.json'))
const { createServer } = await import(pathToFileURL(frontendRequire.resolve('vite')).href)

// Real TCP, Vite proxy, Nitro worker/runner proxy, H3/NextRequest and installed
// MCP SDK. Only the route's catalogue and verifier are synthetic. No database,
// application business route, provider, stored credential or task is loaded.
test('the real Vite and Nitro proxies preserve the mailbox handshake for persistent and closing clients', { timeout: 60_000 }, async () => {
  await mkdir(join(repository, '.cache'), { recursive: true })
  const directory = await mkdtemp(join(repository, '.cache/dev-mcp-http-'))
  const entry = join(directory, 'entry.ts')
  await writeFile(entry, `import { defineHandler } from 'nitro';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { z } from 'zod';
import { createApiHandler } from ${JSON.stringify(join(repository, 'apps/api/src/application.ts'))};
const token = 'mkw_' + 'A'.repeat(43);
const handler = withMcpAuth(request => createMcpHandler(server => {
  server.registerTool('mailbox_inbox', { inputSchema: z.object({}) }, () => ({ content: [] }));
}, { serverInfo: { name: 'synthetic-http-contract', version: '1' } })(request),
async (_request, bearer) => bearer === token ? { token, clientId: 'synthetic', scopes: [] } : undefined, { required: true });
const app = createApiHandler([{ path: '/mikka/api/mcp', template: '/api/mcp', source: 'synthetic-http-contract', methods: ['POST'], load: async () => ({ POST: handler }) }]);
export default defineHandler(event => app.fetch(event.req));\n`, { mode: 0o600 })
  const proxyAgent = new Agent({ keepAlive: true, maxSockets: 256, maxTotalSockets: 256, maxFreeSockets: 64 })
  let nitro: Awaited<ReturnType<typeof createNitro>> | undefined
  let vite: Awaited<ReturnType<typeof createServer>> | undefined
  let worker: ReturnType<typeof developmentWorkerReady> | undefined
  try {
    nitro = await createNitro({ rootDir: directory, workspaceDir: repository, dev: true, preset: 'nitro-dev', builder: 'rolldown', logLevel: 0,
      buildDir: join(directory, 'build'), output: { dir: join(directory, 'output') }, routes: { '/**': entry }, serveStatic: false, publicAssets: [], imports: false }, { dotenv: false })
    const api = createDevServer(nitro)
    worker = developmentWorkerReady(api)
    const compiled = Promise.withResolvers<void>(); void compiled.promise.catch(() => {})
    nitro.hooks.hookOnce('dev:reload', () => { compiled.resolve() })
    nitro.hooks.hookOnce('dev:error', error => { compiled.reject(error) })
    const listener = api.listen({ port: 0, hostname: '127.0.0.1' }); await listener.ready()
    await prepare(nitro); await build(nitro); await compiled.promise; await worker.wait(AbortSignal.timeout(30_000))
    vite = await createServer({ configFile: false, root: directory, base: '/mikka/', appType: 'custom', logLevel: 'silent',
      optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, cors: false,
        proxy: apiProxyOptions(listener.url, proxyAgent) } })
    await vite.listen()
    const address = vite.httpServer!.address()
    assert.ok(address && typeof address !== 'string')
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mikka/api/mcp`)
    const assignment = { runId: '28700000-0000-4000-8000-000000000041',
      mcp: { url: endpoint.href, token: 'mkw_' + 'A'.repeat(43), mailbox: true } } as RunAssignment
    for (const clientConnection of [undefined, 'close']) {
      const statuses: [string, number][] = []
      const mailbox = await createRunMailbox({ assignment, endpoint, signal: AbortSignal.timeout(10_000), check() {},
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers)
          if (clientConnection) headers.set('connection', clientConnection)
          const response = await fetch(input, { ...init, headers })
          statuses.push([JSON.parse(String(init?.body)).method, response.status])
          return response
        } })
      assert.deepEqual(statuses, [['initialize', 200], ['notifications/initialized', 202], ['tools/list', 200]])
      assert.deepEqual(mailbox?.tools.map(tool => tool.name), ['mailbox_inbox'])
      await mailbox!.close()
    }
    const unauthorized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }), signal: AbortSignal.timeout(5_000) })
    assert.equal(unauthorized.status, 401)
    await unauthorized.body?.cancel()

    // Do not let a client Agent close the socket for us: a downstream close
    // request must receive the server's FIN, independently of the proxy pool.
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    const socket = createConnection({ host: '127.0.0.1', port: address.port })
    let wire = ''
    try {
      await new Promise<void>((resolve, reject) => {
        socket.setTimeout(3_000, () => { reject(new Error('DEV_MCP_CLIENT_CLOSE_TIMEOUT')); socket.destroy() })
        socket.once('error', () => reject(new Error('DEV_MCP_CLIENT_CLOSE_FAILED')))
        socket.once('connect', () => socket.write(`POST /mikka/api/mcp HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer ${assignment.mcp!.token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`))
        socket.on('data', data => {
          wire += data.toString('utf8')
          if (wire.length > 4096) { reject(new Error('DEV_MCP_CLIENT_CLOSE_RESPONSE_LIMIT')); socket.destroy() }
          else if (wire.includes('\r\n\r\n') && !wire.toLowerCase().includes('\r\nconnection: close\r\n')) {
            reject(new Error('DEV_MCP_CLIENT_CLOSE_HEADER')); socket.destroy()
          }
        })
        socket.once('end', resolve)
      })
      assert.ok(wire.startsWith('HTTP/1.1 202 '), 'the closing client receives the real notification acknowledgement')
    } finally { socket.destroy() }
  } finally {
    worker?.dispose()
    try { await nitro?.close() }
    finally {
      try { await vite?.close() }
      finally { proxyAgent.destroy(); await rm(directory, { recursive: true, force: true }) }
    }
  }
})

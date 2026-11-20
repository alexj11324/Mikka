import { basename } from 'node:path'
import { bodyBytes, bodyJson, incomingRequest, json, requestRecord } from './http.mjs'

export const LOCAL_E2B_KEY = 'mikka-local-e2b'

function connectFrame(value, end = false) {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(5)
  header[0] = end ? 2 : 0
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

/** e2b@2.61 control API + envd HTTP/Connect JSON protocol, not a Sandbox mock. */
export function createE2BFake({ now = () => Date.now(), templates = ['base', 'desktop', 'claude', 'codex'], limit = 8, commands = {}, processes } = {}) {
  const requests = [], sandboxes = new Map(), idempotency = new Map()
  let sequence = 0, pid = 100
  const state = { limit, templates: new Set(templates), commands, createError: null,
    metrics: /** @type {null | ((input: { sandbox: { id: string }, url: URL }) => unknown[])} */ (null) }
  const view = sandbox => ({ sandboxID: sandbox.id, templateID: sandbox.template, clientID: 'local-client',
    domain: 'localhost', envdVersion: '0.5.6', envdAccessToken: sandbox.access,
    startedAt: new Date(sandbox.created).toISOString(), endAt: new Date(sandbox.expires).toISOString(),
    metadata: sandbox.metadata, state: sandbox.state, cpuCount: 1, memoryMB: 512 })
  const current = id => {
    const sandbox = sandboxes.get(id)
    if (!sandbox || sandbox.state === 'killed') return null
    if (sandbox.expires <= now()) { sandbox.state = 'killed'; return null }
    return sandbox
  }
  const missing = response => json(response, { code: 404, message: 'Sandbox not found' }, 404)
  async function routes(request, response, url) {
    if (!url.pathname.startsWith('/e2b/')) return false
    if (url.pathname.startsWith('/e2b/api/')) {
      const path = url.pathname.slice('/e2b/api'.length), method = request.method
      const body = ['POST', 'PUT'].includes(method) ? await bodyJson(request) : undefined
      requests.push(requestRecord(request, url, body))
      if (request.headers['x-api-key'] !== LOCAL_E2B_KEY) return json(response, { code: 401, message: 'Invalid API key' }, 401)
      if (path === '/v2/sandboxes' && method === 'POST') {
        if (state.createError) return json(response, { code: state.createError, message: 'Scripted create failure' }, state.createError)
        if (!state.templates.has(body.templateID)) return json(response, { code: 404, message: 'Template not found' }, 404)
        if (body.timeout !== undefined && (!Number.isInteger(body.timeout) || body.timeout <= 0)) return json(response, { code: 400, message: 'Invalid timeout' }, 400)
        const key = request.headers['idempotency-key']
        if (key && idempotency.has(key)) {
          const previous = current(idempotency.get(key))
          return previous ? json(response, view(previous), 201) : missing(response)
        }
        if ([...sandboxes.values()].filter(sandbox => current(sandbox.id)).length >= state.limit)
          return json(response, { code: 429, message: 'Concurrent sandbox limit reached' }, 429)
        const id = `local-sandbox-${++sequence}`
        const sandbox = { id, template: body.templateID, metadata: body.metadata ?? {}, state: 'running',
          created: now(), expires: now() + (body.timeout ?? 300) * 1000, access: `local-envd-${sequence}`, files: new Map() }
        sandboxes.set(id, sandbox)
        await processes?.create(sandbox)
        if (key) idempotency.set(key, id)
        return json(response, view(sandbox), 201)
      }
      if (path === '/v2/sandboxes' && method === 'GET') return json(response, [...sandboxes.values()].filter(sandbox => current(sandbox.id)).map(view))
      const match = /^\/(?:v2\/)?sandboxes\/([^/]+)(?:\/(connect|timeout|pause|metrics))?$/.exec(path)
      if (!match) return json(response, { code: 404, message: 'Unknown E2B API route' }, 404)
      const sandbox = current(decodeURIComponent(match[1]))
      if (!sandbox) return missing(response)
      if (method === 'DELETE' && !match[2]) { sandbox.state = 'killed'; await processes?.kill(sandbox); response.writeHead(204); response.end(); return true }
      if (method === 'GET' && !match[2]) return json(response, view(sandbox))
      if (method === 'POST' && match[2] === 'connect') {
        sandbox.state = 'running'
        if (body.timeout !== undefined) sandbox.expires = now() + body.timeout * 1000
        return json(response, view(sandbox))
      }
      if (method === 'POST' && match[2] === 'timeout') {
        if (!Number.isInteger(body.timeout) || body.timeout <= 0) return json(response, { code: 400, message: 'Invalid timeout' }, 400)
        sandbox.expires = now() + body.timeout * 1000
        response.writeHead(204); response.end(); return true
      }
      if (method === 'POST' && match[2] === 'pause') { sandbox.state = 'paused'; response.writeHead(204); response.end(); return true }
      if (method === 'GET' && match[2] === 'metrics') return json(response, state.metrics ? state.metrics({ sandbox, url })
        : [{ timestamp: new Date(now()).toISOString(), cpuCount: 1, cpuUsedPct: 0, memUsed: 0, memTotal: 512 * 1024 * 1024, memCache: 0, diskUsed: 0, diskTotal: 1024 * 1024 * 1024 }])
      return json(response, { code: 405, message: 'Method not allowed' }, 405)
    }
    if (!url.pathname.startsWith('/e2b/envd/')) return json(response, { message: 'Unknown E2B endpoint' }, 404)
    const sandbox = current(request.headers['e2b-sandbox-id'])
    if (!sandbox) return missing(response)
    if (request.headers['x-access-token'] !== sandbox.access) return json(response, { message: 'Unauthorized' }, 401)
    const path = url.pathname.slice('/e2b/envd'.length)
    const user = request.headers.authorization === `Basic ${Buffer.from('root:').toString('base64')}` ? 'root' : 'user'
    if (path === '/health') { requests.push(requestRecord(request, url)); return json(response, { status: 'ok' }) }
    if (path === '/files' && request.method === 'GET') {
      requests.push(requestRecord(request, url))
      const file = processes ? await processes.read(sandbox, url.searchParams.get('path')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error }) : sandbox.files.get(url.searchParams.get('path'))
      if (!file) return json(response, { message: 'File not found' }, 404)
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.length }); response.end(file); return true
    }
    if (path === '/files' && request.method === 'POST') {
      const form = await incomingRequest(request, url).formData(), entries = []
      for (const file of form.getAll('file')) {
        const target = url.searchParams.get('path') ?? file.name
        if (typeof target !== 'string' || !target.startsWith('/')) return json(response, { message: 'Invalid path' }, 400)
        const data = Buffer.from(await file.arrayBuffer())
        sandbox.files.set(target, data)
        await processes?.write(sandbox, target, data, user)
        entries.push({ name: basename(target), path: target, type: 'file' })
      }
      requests.push(requestRecord(request, url, entries))
      return json(response, entries)
    }
    if (processes && path === '/process.Process/StreamInput' && request.method === 'POST') {
      let buffered = Buffer.alloc(0), processId
      requests.push(requestRecord(request, url))
      for await (const chunk of request) {
        buffered = Buffer.concat([buffered, chunk])
        if (buffered.length > 16 * 1024 * 1024) throw new Error('E2B_INPUT_TOO_LARGE')
        while (buffered.length >= 5 && buffered.length >= buffered.readUInt32BE(1) + 5) {
          const size = buffered.readUInt32BE(1), value = JSON.parse(buffered.subarray(5, size + 5).toString())
          buffered = buffered.subarray(size + 5)
          if (value.start) {
            processId = value.start.process?.pid
            if (!await processes.process(sandbox, processId)) return json(response, { code: 'not_found', message: 'Process not found' }, 404)
          } else if (value.data && processId) await processes.input(sandbox, processId, Buffer.from(value.data.input?.stdin ?? '', 'base64'))
          else if (!value.keepalive) throw new Error('E2B_INPUT_FRAME_INVALID')
        }
      }
      if (buffered.length || !processId) throw new Error('E2B_INPUT_INCOMPLETE')
      response.writeHead(200, { 'content-type': 'application/connect+json' })
      response.write(connectFrame({})); response.end(connectFrame({}, true)); return true
    }
    if (processes && ['/process.Process/SendInput', '/process.Process/CloseStdin', '/process.Process/SendSignal'].includes(path) && request.method === 'POST') {
      const body = await bodyJson(request), processId = body.process?.pid
      requests.push(requestRecord(request, url, { process: { pid: processId }, ...(body.signal ? { signal: body.signal } : {}) }))
      if (!await processes.process(sandbox, processId)) return json(response, { code: 'not_found', message: 'Process not found' }, 404)
      if (path.endsWith('/SendInput')) await processes.input(sandbox, processId, Buffer.from(body.input?.stdin ?? '', 'base64'))
      else if (path.endsWith('/CloseStdin')) await processes.closeInput(sandbox, processId)
      else {
        const signal = { SIGNAL_SIGKILL: 'SIGKILL', SIGNAL_SIGTERM: 'SIGTERM', 9: 'SIGKILL', 15: 'SIGTERM' }[body.signal]
        if (!signal) return json(response, { code: 'invalid_argument', message: 'Unknown process signal' }, 400)
        await processes.signal(sandbox, processId, signal)
      }
      return json(response, {})
    }
    if (path === '/process.Process/Start' && request.method === 'POST') {
      const bytes = await bodyBytes(request)
      const envelope = request.headers['content-type']?.startsWith('application/connect+')
      const body = JSON.parse((envelope ? bytes.subarray(5) : bytes).toString())
      const process = body.process
      requests.push(requestRecord(request, url, body))
      if (!process || !['/bin/bash', '/bin/sh'].includes(process.cmd) || !Array.isArray(process.args))
        return json(response, { code: 'invalid_argument', message: 'Invalid process command' }, 400)
      const command = process.args.at(-1)
      const answer = typeof state.commands === 'function' ? await state.commands(command, { sandbox, process }) : state.commands[command]
      if (processes && answer === undefined) {
        const job = await processes.start(sandbox, process, { stdin: body.stdin, user })
        response.writeHead(200, { 'content-type': 'application/connect+json' })
        const output = event => {
          if (response.destroyed || response.writableEnded) return
          if (event.type === 'start') response.write(connectFrame({ event: { start: { pid: event.pid } } }))
          else if (['stdout', 'stderr'].includes(event.type)) response.write(connectFrame({ event: { data: { [event.type]: event.data } } }))
          else if (event.type === 'end') {
            response.write(connectFrame({ event: { end: { exitCode: event.exitCode, exited: true, status: 'exited' } } }))
            response.end(connectFrame({}, true)); job.off('event', output)
          }
        }
        for (const event of job.events) output(event)
        if (job.exited === undefined) job.on('event', output)
        response.once('close', () => job.off('event', output))
        return true
      }
      response.writeHead(200, { 'content-type': 'application/connect+json' })
      response.write(connectFrame({ event: { start: { pid: ++pid } } }))
      if (answer?.timeout) {
        response.end(connectFrame({ error: { code: 'deadline_exceeded', message: 'Command timed out' } }, true))
        return true
      }
      const result = answer ?? { exitCode: 127, stderr: 'Command not scripted\n' }
      for (const [name, data] of Object.entries(result.files ?? {})) sandbox.files.set(name, Buffer.from(data))
      for (const stream of ['stdout', 'stderr']) if (result[stream]) response.write(connectFrame({ event: { data: { [stream]: Buffer.from(result[stream]).toString('base64') } } }))
      response.write(connectFrame({ event: { end: { exitCode: result.exitCode ?? 0, exited: true, status: 'exited' } } }))
      response.end(connectFrame({}, true)); return true
    }
    return json(response, { code: 'unimplemented', message: 'Unknown envd operation' }, 404)
  }
  return { routes, state, requests, sandboxes, close: () => processes?.close(), expire(id) { const sandbox = sandboxes.get(id); if (sandbox) sandbox.expires = now() - 1 } }
}

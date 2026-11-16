import assert from 'node:assert/strict'
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

// This loopback fixture exposes only the two previous real-GGUF providers. A
// pause between actual SSE frames keeps the live turn open while a user types.
const dir = process.env.E_GATE_QA_DIR ?? process.env.E_CODEX_QA
const model = 'SmolLM2-135M-Instruct-Q4_K_M'
const allowed = new Set(['/v1/models', '/v1/messages', '/v1/messages/count_tokens', '/v1/responses'])
const secret = process.env.E_LOOPBACK_KEY
assert.ok(dir && secret && secret.length >= 32)
const same = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
async function handle(req, res) {
  const path = new URL(req.url, 'http://127.0.0.1').pathname
  if (req.socket.remoteAddress !== '127.0.0.1' || !allowed.has(path)) { res.writeHead(404).end(); return }
  const anthropic = Boolean(req.headers['x-api-key'])
  const supplied = anthropic ? req.headers['x-api-key'] : req.headers.authorization
  if (!same(String(supplied ?? ''), anthropic ? secret : `Bearer ${secret}`)) { res.writeHead(401).end(); return }
  const headers = anthropic ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${secret}` }
  if (req.method === 'GET' && path === '/v1/models') {
    const actual = await fetch('http://127.0.0.1:3858/v1/models', { headers: { 'x-api-key': secret } })
    const catalog = await actual.json()
    assert.ok(actual.ok && catalog.data.some(item => item.id === model))
    res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(catalog)); return
  }
  if (req.method !== 'POST') { res.writeHead(405).end(); return }
  let input = ''
  for await (const chunk of req) { input += chunk; if (input.length > 2_000_000) { res.writeHead(413).end(); return } }
  const stop = new AbortController()
  res.on('close', () => { if (!res.writableEnded) stop.abort() })
  const upstream = await fetch((anthropic ? 'http://127.0.0.1:3858' : 'https://127.0.0.1:3857') + path,
    { method:'POST', headers:{...headers,'content-type':'application/json'}, body:input, signal:stop.signal, redirect:'error' })
  const type = upstream.headers.get('content-type') ?? 'application/json'
  res.writeHead(upstream.status, {'content-type':type})
  if (!type.includes('text/event-stream')) { res.end(await upstream.text()); return }
  const settingPath = join(dir, 'current-gate.json')
  const gate = existsSync(settingPath) ? JSON.parse(readFileSync(settingPath, 'utf8')) : undefined
  const use = gate && input.includes(gate.marker) && !existsSync(join(dir,gate.id + '.observed'))
  const decoder = new TextDecoder(); let pending = ''
  for await (const bytes of upstream.body) {
    pending += decoder.decode(bytes, {stream:true})
    let end
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0,end + 2); pending = pending.slice(end + 2)
      res.write(frame)
      if (use && /event: (?:content_block_delta|response\.output_text\.delta|response\.function_call_arguments\.delta)\n/.test(frame) && !existsSync(join(dir,gate.id + '.observed'))) {
        writeFileSync(join(dir,gate.id + '.observed'), JSON.stringify({at:new Date().toISOString(),frameSha256:createHash('sha256').update(frame).digest('hex')}), {flag:'wx',mode:0o600})
        for (let i=0; i<1200 && !stop.signal.aborted && !existsSync(join(dir,gate.id+'.release')); i++) await wait(100)
        if (stop.signal.aborted) return
        assert.ok(existsSync(join(dir,gate.id+'.release')), 'Timed out waiting for this transfer to finish')
      }
    }
  }
  res.end(pending + decoder.decode())
}
createServer((req,res) => {void handle(req,res).catch(()=>{if (!res.headersSent) res.writeHead(502);res.end()})}).listen(3860,'127.0.0.1')

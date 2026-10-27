// One owner-scoped headless browser. Chromium's debugging transport is a
// private pipe, never a TCP port: E2B forwards even loopback TCP listeners.
// The only local interface is a mode-0600 Unix socket in a mode-0700 folder.
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, isIP } from 'node:net'

const id = process.argv[2]
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id ?? '')) throw new Error('Invalid subagent')
const root = `/home/user/.mikka/subagents/${id}`
mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
const socketPath = `${root}/browser.sock`
try { unlinkSync(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--password-store=basic', `--user-data-dir=${root}/profile`, '--window-size=1280,800', '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
let seq = 0, buffer = '', session, frameSubscribers = new Set()
const pending = new Map()
function call(method, params = {}, sessionId = session) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser request timed out')) }, 30_000)
    pending.set(id, { resolve, reject, timer })
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
  })
}
chrome.stdio[4].on('data', data => {
  buffer += data.toString()
  if (buffer.length > 32 * 1024 * 1024) { chrome.kill(); return }
  let end
  while ((end = buffer.indexOf('\0')) >= 0) {
    let message
    try { message = JSON.parse(buffer.slice(0, end)) } catch { chrome.kill(); return }
    buffer = buffer.slice(end + 1)
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer)
      message.error ? item.reject(new Error('Browser rejected request')) : item.resolve(message.result)
    } else if (message.method === 'Page.screencastFrame') {
      const frame = JSON.stringify({ type: 'frame', data: message.params.data, metadata: message.params.metadata }) + '\n'
      for (const client of frameSubscribers) if (!client.destroyed && client.writableLength < 8 * 1024 * 1024) client.write(frame)
      void call('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => undefined)
    }
  }
})
chrome.on('exit', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser stopped')) }; pending.clear(); process.exit(1) })

const visibleElements = `Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"]')).filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'})`
async function evaluate(expression) {
  const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (value.exceptionDetails || value.result?.subtype === 'error') throw new Error('Page inspection failed')
  return value.result?.value
}
function publicUrl(input) {
  const url = new URL(input)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new Error('Address unavailable')
  return url.href
}
async function dispatch(request, client) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid request')
  switch (request.action) {
    case 'navigate': return call('Page.navigate', { url: publicUrl(request.url) })
    case 'snapshot': return evaluate(`(()=>({title:String(document.title).slice(0,300),url:location.href,text:String(document.body?.innerText||'').slice(0,12000),elements:${visibleElements}.slice(0,100).map((e,i)=>({ref:i,tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),label:String(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||'').trim().slice(0,160),type:e.getAttribute('type')}))}))()`)
    case 'click': {
      if (!Number.isInteger(request.ref) || request.ref < 0 || request.ref >= 100) throw new Error('Invalid element')
      const point = await evaluate(`(()=>{const e=${visibleElements}[${request.ref}];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Element unavailable')
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
      return call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    }
    case 'type': {
      if (typeof request.text !== 'string' || !request.text.length || request.text.length > 8000) throw new Error('Invalid input')
      return call('Input.insertText', { text: request.text })
    }
    case 'mouse': {
      if (!['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseWheel'].includes(request.type) || !Number.isFinite(request.x) || !Number.isFinite(request.y) || request.x < 0 || request.y < 0 || request.x > 1280 || request.y > 800) throw new Error('Invalid input')
      return call('Input.dispatchMouseEvent', { type: request.type, x: request.x, y: request.y, ...(request.type === 'mouseWheel' ? { deltaX: Number(request.deltaX) || 0, deltaY: Number(request.deltaY) || 0 } : { button: ['none','left','middle','right'].includes(request.button) ? request.button : 'none', clickCount: request.type === 'mouseMoved' ? 0 : 1 }) })
    }
    case 'key': {
      if (!['keyDown','keyUp','char'].includes(request.type) || typeof request.key !== 'string' || request.key.length > 64 || (request.text !== undefined && (typeof request.text !== 'string' || request.text.length > 32))) throw new Error('Invalid input')
      return call('Input.dispatchKeyEvent', { type: request.type, key: request.key, ...(request.text ? { text: request.text } : {}) })
    }
    case 'subscribe':
      frameSubscribers.add(client)
      if (frameSubscribers.size === 1) await call('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 })
      return { subscribed: true }
    case 'cookies': return call('Storage.getCookies', {}, null)
    case 'setCookies':
      if (!Array.isArray(request.cookies) || request.cookies.length > 5000) throw new Error('Invalid cookies')
      return call('Storage.setCookies', { cookies: request.cookies }, null)
    case 'close': setTimeout(() => { chrome.kill(); process.exit(0) }, 20); return { closed: true }
    default: throw new Error('Unsupported request')
  }
}

await call('Browser.getVersion', {}, null)
const targets = await call('Target.getTargets', {}, null)
const target = targets.targetInfos.find(item => item.type === 'page')
if (!target) throw new Error('Browser page unavailable')
session = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null)).sessionId
await call('Page.enable'); await call('Runtime.enable')
let actions = Promise.resolve()
const server = createServer(client => {
  let input = ''
  client.on('data', chunk => {
    input += chunk.toString()
    if (input.length > 2 * 1024 * 1024) { client.destroy(); return }
    let end
    while ((end = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, end); input = input.slice(end + 1)
      const execute = async () => {
        let request
        try { request = JSON.parse(line); const result = await dispatch(request, client); client.write(JSON.stringify({ id: request.id, result }) + '\n') }
        catch { client.write(JSON.stringify({ id: request?.id ?? null, error: 'Browser request unavailable' }) + '\n') }
      }
      actions = actions.then(execute, execute)
    }
  })
  client.on('close', () => { frameSubscribers.delete(client); if (!frameSubscribers.size) void call('Page.stopScreencast').catch(() => undefined) })
})
server.listen(socketPath, () => chmodSync(socketPath, 0o600))

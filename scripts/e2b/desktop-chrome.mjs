// A normal visible Bot desktop, with a private CDP pipe used only to keep its
// login cookies in sync with the Bot machine's other browsers.
import { spawn } from 'node:child_process'
import { cookieSynchronizer } from './cookie-sync.mjs'

const display = process.argv[2]
if (!/^[1-9][0-9]{0,2}$/.test(display ?? '')) throw new Error('Invalid display')
const chrome = spawn('/usr/bin/chromium', ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--password-store=basic', `--user-data-dir=/home/user/.mikka/profiles/${display}`, '--window-size=1280,800', '--remote-debugging-pipe', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
let sequence = 0, buffer = ''
const pending = new Map()
function call(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser unavailable')) }, 10_000)
    pending.set(id, { resolve, reject, timer })
    chrome.stdio[3].write(JSON.stringify({ id, method, params }) + '\0')
  })
}
chrome.stdio[4].on('data', chunk => {
  buffer += chunk.toString()
  if (buffer.length > 32 * 1024 * 1024) { chrome.kill(); return }
  let end
  while ((end = buffer.indexOf('\0')) >= 0) {
    let message
    try { message = JSON.parse(buffer.slice(0, end)) } catch { chrome.kill(); return }
    buffer = buffer.slice(end + 1)
    const item = pending.get(message.id)
    if (!item) continue
    pending.delete(message.id); clearTimeout(item.timer)
    if (message.error) item.reject(new Error('Browser unavailable'))
    else item.resolve(message.result)
  }
})
chrome.on('exit', () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser stopped')) }; process.exit(0) })
await call('Browser.getVersion')
const synchronize = cookieSynchronizer(call)
let sync = Promise.resolve()
const tick = () => { sync = sync.then(synchronize, synchronize).catch(() => undefined) }
tick()
setInterval(tick, 3000)

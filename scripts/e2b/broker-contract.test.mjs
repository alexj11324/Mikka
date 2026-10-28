// Exercise the actual credential browser client with synthetic socket replies.
// The Python test validates the resulting commands against the gateway policy.
import { Cdp } from '../../lib/credentials/browser.ts'

const commands = []
class Socket extends EventTarget {
  readyState = 1
  send(raw) {
    const command = JSON.parse(raw); commands.push(command)
    let result = {}
    if (command.method === 'Target.attachToTarget') result = { sessionId: 'bound' }
    if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { url: 'https://example.test/login', id: 'frame' } } }
    if (command.method === 'DOM.getDocument') result = { root: { nodeName: '#document' } }
    if (command.method === 'Runtime.evaluate') result = command.params.expression === 'globalThis' ? { result: { objectId: 'known' } } : { result: { value: true } }
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result }) })))
  }
  close() { this.readyState = 3 }
}
const client = new Cdp(new Socket())
await client.attach('target')
await client.fill('https://example.test', 'synthetic-user', 'synthetic-password')
await client.fillOtp('https://example.test', '123456')
await client.safeToResume('https://example.test/login')
await client.evaluate('Object.entries(localStorage)')
await client.evaluate('document.readyState===\'complete\'&&!document.querySelector(\'input[type="password"]\')')
await client.evaluate('Boolean([...document.querySelectorAll(\'input[autocomplete="one-time-code"],input[name="code"],input[name="otp"]\')].find(e=>!e.disabled&&e.getClientRects().length))')
await client.call('Network.getCookies', { urls: ['https://example.test'] })
await client.call('Network.setCookies', { cookies: [{ name: 'session', value: 'synthetic', domain: '.example.test', path: '/' }] })
await client.call('Runtime.evaluate', { expression: 'globalThis', returnByValue: false })
await client.call('Runtime.callFunctionOn', { objectId: 'known', functionDeclaration: 'function(entries){localStorage.clear();for(const [k,v] of entries)localStorage.setItem(k,v)}', arguments: [{ value: [['key', 'synthetic']] }], returnByValue: true })
await client.call('Page.reload')
client.close()
process.stdout.write(JSON.stringify(commands))

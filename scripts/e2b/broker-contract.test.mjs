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
    if (command.method === 'Page.getFrameTree') result = { frameTree: { frame: { url: 'https://example.test/login', id: 'frame', loaderId: 'loader' } } }
    if (command.method === 'DOM.getDocument') result = { root: { nodeName: '#document', children: [{ nodeName: 'INPUT', backendNodeId: 7, attributes: ['type', 'password'] }] } }
    if (command.method === 'Runtime.evaluate') result = { result: { objectId: 'active' } }
    if (command.method === 'DOM.describeNode') result = { node: { backendNodeId: 7 } }
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: command.id, result }) })))
  }
  close() { this.readyState = 3 }
}
const client = new Cdp(new Socket())
await client.attach('target')
await client.insertAtObservedInput('https://example.test', 'loader', 7, 'password', 'synthetic-password')
client.close()
process.stdout.write(JSON.stringify(commands))

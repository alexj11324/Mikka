// Only the mocked Docker ownership/database suite imports this guard. Its
// descriptor files remain real and confined to its own temporary directory;
// HTTP/WebSocket loopback tests run in a separate, unguarded Node process.
import net from 'node:net'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

const deny = () => { throw Object.assign(new Error('Offline adapter test attempted real transport'), { code: 'OFFLINE_TRANSPORT_FORBIDDEN' }) }
globalThis.fetch = deny
net.Socket.prototype.connect = deny
net.createConnection = deny
net.connect = deny
net.createServer = deny
http.request = deny
http.get = deny
http.createServer = deny
https.request = deny
https.get = deny
syncBuiltinESMExports()

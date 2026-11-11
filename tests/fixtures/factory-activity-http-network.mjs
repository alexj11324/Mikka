// The owned Vite/Nitro child and its workers may reach only local PostgreSQL,
// their own HTTP listeners and local IPC. No route/auth behavior is replaced.
import { appendFileSync } from 'node:fs'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'

const receipt = process.env.FACTORY_ACTIVITY_HTTP_NETWORK_RECEIPT
if (!receipt) throw new Error('FACTORY_ACTIVITY_HTTP_NETWORK_RECEIPT_REQUIRED')
const local = host => ['127.0.0.1','localhost','::1','[::1]'].includes(host)
const refuse = () => {
  appendFileSync(receipt,'blocked\n',{mode:0o600})
  throw new Error('FACTORY_ACTIVITY_HTTP_EXTERNAL_TRANSPORT_FORBIDDEN')
}
appendFileSync(receipt,'guard-start\n',{mode:0o600})
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...input) {
  const args = Array.isArray(input[0]) ? input[0] : input
  const first = args[0]
  const options = typeof first==='object' && first!==null ? first : null
  const path = options?.path ?? (typeof first==='string' && !/^\d+$/.test(first) ? first : null)
  if (!path) {
    const host = options?.host ?? (typeof args[1]==='string' ? args[1] : 'localhost')
    if (!local(host)) refuse()
  }
  return Reflect.apply(connect,this,input)
}
const read = globalThis.fetch
globalThis.fetch = (input,init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (!['http:','https:'].includes(url.protocol) || !local(url.hostname)) refuse()
  return read(input,init)
}
syncBuiltinESMExports()

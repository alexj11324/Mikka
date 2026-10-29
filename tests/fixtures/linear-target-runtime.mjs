// Source-only publication tests use in-memory transaction results. No DB connection.
import { registerHooks } from 'node:module'
const dbSource='export const db={transaction:async fn=>fn(globalThis.linearTargetProbe.tx)};export const pool={options:{}}'
registerHooks({
  resolve(specifier,context,next) {
    if(specifier==='server-only') return {url:'linear-target-fixture:empty',shortCircuit:true}
    const resolved=next(specifier,context)
    if(resolved.url.endsWith('/lib/db/index.ts')) return {url:`linear-target-fixture:${encodeURIComponent(dbSource)}`,shortCircuit:true}
    return resolved
  },
  load(url,context,next) {
    if(url==='linear-target-fixture:empty') return {format:'module',source:'export {}',shortCircuit:true}
    if(url.startsWith('linear-target-fixture:')) return {format:'module',source:decodeURIComponent(url.slice('linear-target-fixture:'.length)),shortCircuit:true}
    return next(url,context)
  },
})

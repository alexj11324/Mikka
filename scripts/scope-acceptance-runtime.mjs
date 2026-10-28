import { registerHooks, syncBuiltinESMExports } from 'node:module'
import childProcess from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transpileModule, ModuleKind, ScriptTarget, JsxEmit } from 'typescript'
import fsp from 'node:fs/promises'
import { SCOPE_LIMITS, checkedScopeUrl } from './scope-acceptance-policy.mjs'
export const SCOPE_IDENTITY_SQL = 'select current_database() as database, current_user as role, (select oid::text from pg_database where datname=current_database()) as oid'

/** Injected pg/RPC make this adapter testable without native pg or sockets. */
export function frozenScopeModule(path, bytes) {
  if(/\.(?:ts|tsx|mts)$/.test(path))return {format:'module',source:transpileModule(bytes.toString(),{fileName:path,compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022,jsx:JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,shortCircuit:true}
  if(path.endsWith('.json'))return {format:'module',source:`export default JSON.parse(${JSON.stringify(bytes.toString())})`,shortCircuit:true}
  if(/\.(?:mjs|js)$/.test(path))return {format:'module',source:bytes.toString(),shortCircuit:true}
  return null
}
export function scopeNativeRuntime(pg, rpc, phase, mode) {
  const clients = new Set(), pools = new Set(), servers = new Set(), ports = new Set()
  const wrapped = new WeakSet()
  let stopped = false, listenerCount = 0, cleanupCount = 0
  const bucket = phase + (mode === 'migrate' ? ':migrate' : '')
  const options = input => {
    if (!input || typeof input !== 'object' || !input.connectionString) throw Error('scope pg requires an explicit URL')
    checkedScopeUrl(input.connectionString, phase)
    return { ...input, statement_timeout: SCOPE_LIMITS.statementMs, lock_timeout: SCOPE_LIMITS.lockMs,
      idle_in_transaction_session_timeout: SCOPE_LIMITS.idleTransactionMs, connectionTimeoutMillis: SCOPE_LIMITS.connectionMs,
      query_timeout: SCOPE_LIMITS.statementMs + 2000, application_name: 'mikka-scope-acceptance-' + bucket }
  }
  async function instrument(client, input) {
    if (wrapped.has(client)) return client
    const url = input.connectionString, database = checkedScopeUrl(url, phase)
    const original = client.query.bind(client)
    clients.add(client);wrapped.add(client)
    const permit = await rpc('query', { bucket, url, text: SCOPE_IDENTITY_SQL, handshake: true })
    try {
      const answer = await original(SCOPE_IDENTITY_SQL)
      const identity = answer.rows[0]
      if (identity?.database !== database || identity?.role !== 'postgres') throw Error('scope connection identity mismatch')
      await rpc('query-result', { id: permit.id, ok: true, rowCount: answer.rowCount ?? 0, identity })
    } catch (error) { await rpc('query-result', { id: permit.id, ok: false, code: error?.code ?? null }); throw error }
    client.query = (...args) => {
      const callback = typeof args.at(-1) === 'function' ? args.pop() : null
      const work = (async () => {
        const config = args[0], text = typeof config === 'string' ? config : config?.text
        if (typeof text !== 'string') throw Error('scope query requires text')
        // A cancelled/aborted transaction still needs its own bounded ROLLBACK.
        if (stopped) {
          if (text.trim().toUpperCase() !== 'ROLLBACK' || ++cleanupCount > 64) throw Error('scope acceptance stopped')
          const permit=await rpc('cleanup',{bucket,url,text})
          try { const answer=await original(...args);await rpc('query-result',{id:permit.id,ok:true,rowCount:answer.rowCount??0,cleanup:true});return answer }
          catch(error){await rpc('query-result',{id:permit.id,ok:false,code:error?.code??null,cleanup:true});throw error}
        }
        const values = typeof config === 'object' ? config.values : args[1]
        const permit = await rpc('query', { bucket, url, text, ledgerName: text === 'insert into schema_migrations (name) values ($1)' ? values?.[0] : undefined })
        if(stopped){await rpc('query-result',{id:permit.id,ok:false,code:'CANCELLED_BEFORE_SUBMIT',rowCount:0});throw Error('scope cancelled before native submission')}
        try {
          const answer = await original(...args), results = Array.isArray(answer) ? answer : [answer]
          await rpc('query-result', { id: permit.id, ok: true, rowCount: results.reduce((n, result) => n + (result?.rowCount ?? 0), 0), commands: results.map(result => result?.command ?? null) })
          return answer
        } catch (error) {
          await rpc('query-result', { id: permit.id, ok: false, code: error?.code ?? null })
          throw error
        }
      })()
      if (callback) { work.then(result => callback(null, result), error => callback(error));return }
      return work
    }
    return client
  }
  class Pool extends pg.Pool {
    constructor(input) { super(options(input)); this.scopeInput = options(input);pools.add(this) }
    connect(callback) {
      const work = (async () => {
        if (stopped) throw Error('scope acceptance stopped')
        await rpc('connect', { bucket, url: this.scopeInput.connectionString })
        if(stopped)throw Error('scope cancelled before connect')
        const client = await new Promise((resolve, reject) => super.connect((error, value) => error ? reject(error) : resolve(value)))
        try { return await instrument(client, this.scopeInput) }
        catch (error) { client.release(true);throw error }
      })()
      if (callback) { work.then(client => callback(null, client, client.release), error => callback(error));return }
      return work
    }
  }
  class Client extends pg.Client {
    constructor(input) { super(options(input));this.scopeInput = options(input) }
    connect(callback) {
      const work = (async () => { await rpc('connect', { bucket, url: this.scopeInput.connectionString });if(stopped)throw Error('scope cancelled before connect');await super.connect();await instrument(this, this.scopeInput) })()
      if (callback) { work.then(() => callback(null), callback);return }
      return work
    }
  }
  async function close() {
    stopped = true
    for (const server of servers) { server.closeAllConnections?.();server.close() }
    // End only clients created through this invocation's pg facade. No SQL
    // cancellation/termination of unrelated sessions, server or container.
    await Promise.allSettled([...clients].filter(client => !client._ending).map(client => client.end()))
    await Promise.allSettled([...pools].filter(pool => !pool.ending).map(pool => pool.end()))
  }
  function cancel() { stopped=true;for(const server of servers){server.closeAllConnections?.();server.close()} }
  function abort(error) { cancel();void rpc('failure', { reason: error?.message ?? 'scope subtest failed' }).catch(() => {}) }
  function install(frozenSources = new Map()) {
    globalThis.scopeAcceptance = { Pool, Client, abort }
    registerHooks({
      resolve(specifier, context, next) { return specifier === 'pg' ? { url: 'scope-acceptance:pg', shortCircuit: true } : next(specifier, context) },
      load(url, context, next) {
        if(url==='scope-acceptance:pg')return {format:'module',source:'export const Pool=globalThis.scopeAcceptance.Pool;export const Client=globalThis.scopeAcceptance.Client;export default {Pool,Client}',shortCircuit:true}
        if(url.startsWith('file:')){const path=fileURLToPath(new URL(url));const bytes=frozenSources.get(path);if(bytes){const loaded=frozenScopeModule(path,bytes);if(loaded)return loaded}}
        return next(url,context)
      },
    })
    const originalRead=fs.readFileSync.bind(fs),originalAsyncRead=fsp.readFile.bind(fsp),originalDirectory=fs.readdirSync.bind(fs)
    const pathOf=value=>value instanceof URL?fileURLToPath(value):String(value)
    const frozenRead=(value,encoding)=>{const bytes=frozenSources.get(pathOf(value));if(!bytes)return null;const format=typeof encoding==='string'?encoding:encoding?.encoding;return format?bytes.toString(format):Buffer.from(bytes)}
    fs.readFileSync=(path,encoding)=>frozenRead(path,encoding)??originalRead(path,encoding)
    fsp.readFile=async(path,encoding)=>frozenRead(path,encoding)??originalAsyncRead(path,encoding)
    fs.readdirSync=(path,options)=>pathOf(path)===process.cwd()+'/drizzle/'?[...frozenSources.keys()].filter(name=>name.startsWith(process.cwd()+'/drizzle/')&&name.endsWith('.sql')).map(name=>name.split('/').at(-1)):originalDirectory(path,options)
    const originalListen = http.Server.prototype.listen
    http.Server.prototype.listen = function (...args) {
      if (stopped || args[0] !== 0 || args[1] !== '127.0.0.1' || ++listenerCount > SCOPE_LIMITS.listeners[phase]) throw Error('scope listener target/budget mismatch')
      servers.add(this)
      let ownedPort
      this.once('listening', () => { ownedPort=this.address().port;ports.add(ownedPort) })
      this.once('close', () => ports.delete(ownedPort))
      return originalListen.apply(this, args)
    }
    const originalConnect = net.Socket.prototype.connect
    net.Socket.prototype.connect = function (...args) {
      const value = Array.isArray(args[0]) ? args[0][0] : args[0]
      const host = typeof value === 'object' ? value.host : args[1]
      const port = Number(typeof value === 'object' ? value.port : value)
      if (stopped || host !== '127.0.0.1' || (port !== 55484 && !ports.has(port))) throw Error('scope socket target denied')
      return originalConnect.apply(this, args)
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (stopped || target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !ports.has(Number(target.port))) throw Error('scope fetch target denied')
      return originalFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(SCOPE_LIMITS.statementMs)]) : AbortSignal.timeout(SCOPE_LIMITS.statementMs) })
    }
    // The one frozen execFile call is migration only; the supervisor owns and
    // budgets that child directly, rather than losing it beneath the test.
    childProcess.execFile = (executable, args, input, callback) => {
      if (mode === 'migrate' || executable !== process.execPath || args?.length !== 1 || args[0] !== 'scripts/migrate.mjs') throw Error('scope child command denied')
      const work = rpc('migrate', { app: input.env.MIKKA_DATABASE_URL, workspace: input.env.DATABASE_URL })
      work.then(result => callback(null, result.stdout, result.stderr), error => callback(error))
      return { kill() { abort(Error('migration child cancelled'));return true } }
    }
    for(const name of ['spawn','spawnSync','fork','exec','execSync','execFileSync'])childProcess[name]=()=>{throw Error('unbudgeted scope subprocess denied')}
    const deny = () => { throw Error('scope filesystem cleanup denied') }
    for (const name of ['unlink','unlinkSync','rm','rmSync','rmdir','rmdirSync','rename','renameSync']) if (name in fs) fs[name] = deny
    for (const name of ['unlink','rm','rmdir','rename']) if (name in fsp) fsp[name] = deny
    syncBuiltinESMExports()
  }
  return { Pool, Client, install, abort, cancel, close, stats: () => ({ stopped, clients: clients.size, listeners: listenerCount, cleanupRollbacks: cleanupCount }) }
}

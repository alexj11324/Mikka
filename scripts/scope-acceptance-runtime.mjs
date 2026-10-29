import { registerHooks, syncBuiltinESMExports } from 'node:module'
import childProcess from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transpileModule, ModuleKind, ScriptTarget, JsxEmit } from 'typescript'
import fsp from 'node:fs/promises'
import { scopeExecFile, scopeOutputFromWire } from './scope-exec-file.mjs'
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
  const wrapped = new WeakSet(), patches = []
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
    const original = (client.query === guardedClientQuery ? originalClientQuery : client.query).bind(client)
    clients.add(client);wrapped.add(client)
    const permit = await rpc('query', { bucket, url, text: SCOPE_IDENTITY_SQL, handshake: true })
    try {
      const answer = await original(SCOPE_IDENTITY_SQL)
      const identity = answer.rows[0]
      if (identity?.database !== database || identity?.role !== 'postgres') throw Error('scope connection identity mismatch')
      await rpc('query-result', { id: permit.id, ok: true, rowCount: answer.rowCount ?? 0, identity })
    } catch (error) { await rpc('query-result', { id: permit.id, ok: false, code: error?.code ?? null }); throw error }
    const query = function (...args) {
      const config = args[0]
      if (config == null) throw new TypeError('Client was passed a null or undefined query')
      const submitted = typeof config.submit === 'function'
      if (submitted && !(config instanceof pg.Query)) throw Error('scope custom streaming queries are not supported')
      const callback = typeof args.at(-1) === 'function' ? args.at(-1) : typeof config.callback === 'function' ? config.callback : null
      const PromiseImpl = client._Promise ?? Promise
      let permit, complete
      const terminal = new PromiseImpl(resolve => { complete = resolve })
      let completion
      const finish = (error, value) => completion ??= (async () => {
        if (permit) {
          const results = Array.isArray(value) ? value : [value]
          await rpc('query-result', error ? { id: permit.id, ok: false, code: error.code ?? null } : { id: permit.id, ok: true, rowCount: results.reduce((n, result) => n + (result?.rowCount ?? 0), 0), commands: results.map(result => result?.command ?? null) })
        }
        return { error, value }
      })().catch(failure => ({ error: failure })).then(outcome => { complete(outcome);return outcome })
      if (submitted) {
        const emit = config.emit
        let errorReported = false
        const reportError = error => { if (!errorReported) { errorReported = true;emit.call(config, 'error', error) } }
        config.emit = function (event, ...values) {
          if (!['end','error'].includes(event)) return emit.call(this, event, ...values)
          const observed = this.listenerCount(event) > 0
          void finish(event === 'error' ? values[0] : null, values[0]).then(outcome => {
            if (outcome.error) { if (!callback) reportError(outcome.error) }
            else emit.call(this, event, ...values)
          })
          return observed
        }
        // Native pg also installs a callback when query_timeout is enabled.
        // Retain event-style errors, and never emit end after a failed result
        // acknowledgement or report the original successful value instead.
        config.callback = (error, value) => { void finish(error, value).then(outcome => {
          if (callback) callback(outcome.error, outcome.value)
          else if (outcome.error) reportError(outcome.error)
        }) }
      }
      void (async () => {
        const text = typeof config === 'string' ? config : config.text
        if (typeof text !== 'string') throw Error('scope query requires text')
        const values = typeof config === 'object' ? config.values : args[1]
        if (stopped) {
          if (text.trim().toUpperCase() !== 'ROLLBACK' || ++cleanupCount > 64) throw Error('scope acceptance stopped')
          permit = await rpc('cleanup', { bucket, url, text })
        } else {
          permit = await rpc('query', { bucket, url, text, ledgerName: text === 'insert into schema_migrations (name) values ($1)' ? values?.[0] : undefined })
          if (stopped) throw Object.assign(Error('scope cancelled before native submission'), { code: 'CANCELLED_BEFORE_SUBMIT' })
        }
        if (submitted) original(config)
        else {
          const input = typeof config === 'object' ? { ...config, callback: undefined } : config
          const parameters = typeof args[1] === 'function' ? undefined : args[1]
          // Use the real driver's callback path, including QueryConfig.types,
          // rowMode and serialization; do not reconstruct Result or parsers.
          const result = original(input, parameters, (error, value) => { void finish(error, value) })
          if (result?.then) result.then(value => finish(null, value), error => finish(error))
        }
      })().catch(error => {
        if (submitted) {
          if (callback) config.callback(error)
          else config.emit('error', error)
        } else void finish(error)
      })
      if (submitted) return config
      if (callback) { terminal.then(({error,value}) => callback(error, value));return }
      return terminal.then(({error,value}) => { if (error) throw error;return value })
    }
    Object.defineProperties(query, Object.getOwnPropertyDescriptors(client.query))
    client.query = query
    return client
  }
  // Keep the installed pg module, constructor identities, exports, descriptors,
  // symbols and native pool release bookkeeping. Only connection/query methods
  // are gated; ESM and CJS callers therefore use the same real driver objects.
  const { Pool, Client } = pg
  const originalClientQuery = Client.prototype.query
  let guardedClientQuery
  function patch(prototype, name, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
    const original = prototype[name]
    Object.defineProperties(replacement, Object.getOwnPropertyDescriptors(original))
    Object.defineProperty(prototype, name, { ...descriptor, value: replacement, configurable: true, writable: true })
    patches.push(() => descriptor ? Object.defineProperty(prototype, name, descriptor) : delete prototype[name])
    return original
  }
  function connectResult(receiver, callback, run) {
    const PromiseImpl = receiver.Promise ?? receiver._Promise ?? Promise
    const work = new PromiseImpl(resolve => run((error, value, release) => resolve({ error, value, release })))
    if (callback) {
      work.then(({ error, value, release }) => callback(error, value, release))
      return
    }
    return work.then(({ error, value }) => { if (error) throw error;return value })
  }
  if (typeof originalClientQuery === 'function') {
    guardedClientQuery = function () { throw Error('scope query before approved connection') }
    patch(Client.prototype, 'query', guardedClientQuery)
  }
  const originalPoolConnect = patch(Pool.prototype, 'connect', function (callback) {
    return connectResult(this, callback, done => {
      Promise.resolve().then(async () => {
        if (stopped) throw Error('scope acceptance stopped')
        // pg-pool retains its own options object and Client constructor.
        Object.assign(this.options, options(this.options));pools.add(this)
        await rpc('connect', { bucket, url: this.options.connectionString })
        if (stopped) throw Error('scope cancelled before connect')
        originalPoolConnect.call(this, (error, client, release) => {
          if (error) return done(error, client, release)
          instrument(client, this.options).then(value => done(null, value, release), failure => { release(failure);done(failure, undefined, () => {}) })
        })
      }).catch(done)
    })
  })
  if (typeof Client.prototype.connect === 'function') {
    const originalClientConnect = patch(Client.prototype, 'connect', function (callback) {
      return connectResult(this, callback ? (error, value) => error ? callback(error) : callback(null, value) : undefined, done => {
        Promise.resolve().then(async () => {
          if (stopped) throw Error('scope acceptance stopped')
          const params = this.connectionParameters
          const connectionString = `postgresql://${params.user}@${params.host}:${params.port}/${params.database}`
          checkedScopeUrl(connectionString, phase)
          if (this.host !== params.host || this.port !== params.port || this.user !== params.user || this.database !== params.database || this.password || params.password || params.options || params.ssl) throw Error('scope effective pg connection mismatch')
          const input = options({ connectionString })
          Object.assign(params, { statement_timeout: input.statement_timeout, lock_timeout: input.lock_timeout, idle_in_transaction_session_timeout: input.idle_in_transaction_session_timeout, query_timeout: input.query_timeout, application_name: input.application_name })
          this._connectionTimeoutMillis = input.connectionTimeoutMillis
          clients.add(this)
          await rpc('connect', { bucket, url: connectionString })
          if (stopped) throw Error('scope cancelled before connect')
          originalClientConnect.call(this, error => {
            if (error) return done(error)
            instrument(this, input).then(() => done(null, this), failure => { void this.end();done(failure) })
          })
        }).catch(done)
      })
    })
  }
  async function close() {
    stopped = true
    for (const server of servers) { server.closeAllConnections?.();server.close() }
    // End only clients created through this invocation's pg facade. No SQL
    // cancellation/termination of unrelated sessions, server or container.
    await Promise.allSettled([...clients].filter(client => !client._ending).map(client => client.end()))
    await Promise.allSettled([...pools].filter(pool => !pool.ending).map(pool => pool.end()))
    for (const restore of patches.reverse()) restore()
  }
  function cancel() { stopped=true;for(const server of servers){server.closeAllConnections?.();server.close()} }
  function abort(error) { cancel();void rpc('failure', { reason: error?.message ?? 'scope subtest failed' }).catch(() => {}) }
  function install(frozenSources = new Map(), resumeScope = false, resumeTeam = false) {
    globalThis.scopeAcceptance = { Pool, Client, abort, ...(resumeScope?{resumeScope:database=>rpc('resume-scope',{database})}:{}), ...(resumeTeam?{resumeTeam:databases=>rpc('resume-team',{databases})}:{}) }
    registerHooks({
      load(url, context, next) {
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
    childProcess.execFile = scopeExecFile((executable,args,input)=>{
      if(mode==='migrate'||executable!==process.execPath||args?.length!==1||args[0]!=='scripts/migrate.mjs')throw Error('scope child command denied')
      return {promise:rpc('migrate',{app:input.env.MIKKA_DATABASE_URL,workspace:input.env.DATABASE_URL}).then(scopeOutputFromWire),cancel:()=>{void rpc('migration-cancel').catch(()=>{})}}
    })
    for(const name of ['spawn','spawnSync','fork','exec','execSync','execFileSync'])childProcess[name]=()=>{throw Error('unbudgeted scope subprocess denied')}
    const deny = () => { throw Error('scope filesystem cleanup denied') }
    for (const name of ['unlink','unlinkSync','rm','rmSync','rmdir','rmdirSync','rename','renameSync']) if (name in fs) fs[name] = deny
    for (const name of ['unlink','rm','rmdir','rename']) if (name in fsp) fsp[name] = deny
    syncBuiltinESMExports()
  }
  return { Pool, Client, install, abort, cancel, close, stats: () => ({ stopped, clients: clients.size, listeners: listenerCount, cleanupRollbacks: cleanupCount }) }
}

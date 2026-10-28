// This task's retained, three-database acceptance only. No pg or process imports.
import { createHash } from 'node:crypto'
export const SCOPE_DATABASES = {
  scope: 'scope184_f14235c6695547ae925d808ab35a399e_e2e',
  app: 'team184_app_69649a2f38184d8b8edf1fe6a6524f31_e2e',
  workspace: 'team184_workspace_1bf3cc4e4430443c841d27f4a5115dc9_e2e',
}
export const SCOPE_LIMITS = Object.freeze({ totalMs: 300000, phaseMs: 140000, migrationMs: 60000, graceMs: 5000,
  statementMs: 20000, lockMs: 10000, idleTransactionMs: 30000, connectionMs: 3000,
  queries: { scope: 11000, team: 7000, 'scope:migrate': 1000, 'team:migrate': 1000 },
  rootQueries: 128, outputBytes: 1 << 20, journalBytes: 32 << 20, listeners: { scope: 5, team: 1 },
  snapshotTables: 100, snapshotLiveRows: 10000 })
export const sqlHash = text => createHash('sha256').update(text).digest('hex')
export function scopeUrl(database) { return `postgresql://postgres@127.0.0.1:55484/${database}` }
export function checkedScopeUrl(value, phase) {
  const url = new URL(value)
  const allowed = phase === 'scope' ? [SCOPE_DATABASES.scope] : [SCOPE_DATABASES.app, SCOPE_DATABASES.workspace]
  allowed.push('issue184_e2e')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '55484' || url.username !== 'postgres' || url.password || url.search || url.hash || !allowed.includes(url.pathname.slice(1))) throw Error('scope acceptance target mismatch')
  return url.pathname.slice(1)
}
export function scopePolicy(migrations, record = () => {}) {
  const state = { failed: null, counts: {}, created: new Map(), createAttempts: new Set(), migrations: new Set(), replays: new Set(), migrationCalls: new Set(), pending: new Map(), results: 0, cleanup: 0, connections: {} }
  const files = new Map(migrations.map(file => [file.sha256, file]))
  for (const file of migrations) if (file.beforeCommitSha256) files.set(file.beforeCommitSha256, file)
  function active() { if (state.failed) throw Error('scope acceptance stopped') }
  function abort(reason) { if (!state.failed) { state.failed = reason;record({ event: 'abort', reason }) } }
  function connect(bucket,input) {
    active()
    if(!(bucket in SCOPE_LIMITS.queries))throw Error('unknown connection bucket')
    const database=checkedScopeUrl(input.url,bucket.split(':')[0])
    if(database!=='issue184_e2e'&&!state.created.has(database))throw Error('unowned DB connection denied')
    state.connections[bucket]=(state.connections[bucket]??0)+1
    if(state.connections[bucket]>SCOPE_LIMITS.queries[bucket])throw Error('scope connection checkout budget exhausted')
    record({event:'connection-checkout-attempt',bucket,database,count:state.connections[bucket]})
  }
  function grant(bucket, input) {
    active()
    if (!(bucket in SCOPE_LIMITS.queries)) throw Error('unknown scope query bucket')
    const phase = bucket.split(':')[0], database = checkedScopeUrl(input.url, phase)
    state.counts[bucket] = (state.counts[bucket] ?? 0) + 1
    if (state.counts[bucket] > SCOPE_LIMITS.queries[bucket]) { abort('query budget exhausted'); throw Error('scope query budget exhausted') }
    const handshake = input.handshake && input.text === 'select current_database() as database, current_user as role, (select oid::text from pg_database where datname=current_database()) as oid'
    const create = /^create database "([a-z0-9_]+)"$/i.exec(input.text)
    if (database === 'issue184_e2e') {
      const names = phase === 'scope' ? [SCOPE_DATABASES.scope] : [SCOPE_DATABASES.app, SCOPE_DATABASES.workspace]
      if (!handshake && (!create || !names.includes(create[1]) || state.createAttempts.has(create[1]))) throw Error('admin DB permits only its exact new CREATE DATABASE')
      if (create) state.createAttempts.add(create[1])
    } else {
      if (!state.created.has(database)) throw Error('database ownership not established')
      if (/^\s*(?:create\s+(?:database|schema|role)|alter\s+(?:database|role)|drop\s+(?:database|schema)|truncate|delete\s+from)\b/i.test(input.text)) throw Error('scope SQL outside retained fixture boundary')
      const file = files.get(sqlHash(input.text))
      if (handshake) { /* Exact connection identity read; still budgeted. */ } else if (bucket.endsWith(':migrate')) {
        if (file) {
          const expected = phase === 'scope' ? SCOPE_DATABASES.scope : file.target === 'DATABASE_URL' ? SCOPE_DATABASES.workspace : SCOPE_DATABASES.app
          const key = database + '/' + file.path
          if (database !== expected || state.migrations.has(key)) throw Error('migration target/repetition mismatch')
          state.migrations.add(key)
        } else if (!['create table if not exists schema_migrations (name text primary key, "appliedAt" timestamptz not null default now())', 'select name from schema_migrations', 'COMMIT', 'ROLLBACK'].includes(input.text)) {
          if (input.text !== 'insert into schema_migrations (name) values ($1)' || !migrations.some(file => file.path.endsWith('/' + input.ledgerName) && state.migrations.has(database + '/' + file.path))) throw Error('unexpected migration query/ledger identity')
        }
      } else if (file) {
        const replay = ['20261027183121_', '20261027183123_', '20261027183124_'].some(prefix => file.path.split('/').at(-1).startsWith(prefix))
        if (phase !== 'scope' || !replay || state.replays.has(file.path)) throw Error('unexpected fixture migration replay')
        state.replays.add(file.path)
      }
    }
    const id = bucket + ':' + state.counts[bucket]
    state.pending.set(id, { bucket, database, create: create?.[1] })
    record({ event: 'query-attempt', id, database, sqlSha256: sqlHash(input.text) })
    return { id, create: create?.[1] }
  }
  function result(id, outcome) {
    const pending = state.pending.get(id)
    if (!pending) throw Error('unknown query result')
    state.pending.delete(id);state.results++
    record({ event: 'query-result', id, ...outcome })
    return pending
  }
  function cleanup(bucket, input) {
    const database=checkedScopeUrl(input.url,bucket.split(':')[0])
    if(input.text.trim().toUpperCase()!=='ROLLBACK'||!state.created.has(database)||++state.cleanup>64)throw Error('cleanup scope/budget mismatch')
    const id='cleanup:'+state.cleanup
    state.pending.set(id,{bucket,database})
    record({event:'cleanup-attempt',id,database})
    return {id}
  }
  function migrated(phase) {
    const expected = phase === 'scope' ? 70 : 70
    if ([...state.migrations].filter(key => phase === 'scope' ? key.startsWith(SCOPE_DATABASES.scope + '/') : !key.startsWith(SCOPE_DATABASES.scope + '/')).length !== expected) throw Error('incomplete migration file count')
  }
  function migrationCall(phase) { active(); if (state.migrationCalls.has(phase)) throw Error('migration child repeated'); state.migrationCalls.add(phase) }
  return { state, active, abort, connect, grant, result, cleanup, migrated, migrationCall }
}

// Own child only. A timeout/cancellation is terminal, never an automatic retry.
export function controlledChild(child, { timeoutMs, graceMs = SCOPE_LIMITS.graceMs, signal, onMessage = () => {}, onOutput = () => {}, maxOutput = SCOPE_LIMITS.outputBytes }) {
  return new Promise((resolve, reject) => {
    let failure, bytes = 0, settled = false
    let grace, soft
    const stop = reason => {
      if (settled || failure) return
      failure = reason
      if(child.connected)child.send({control:'abort'})
      soft = setTimeout(() => child.kill('SIGTERM'), Math.min(2000, graceMs / 2))
      grace = setTimeout(() => child.kill('SIGKILL'), graceMs)
    }
    const timer = setTimeout(() => stop(Error('scope child timeout')), timeoutMs)
    const cancel = () => stop(Error('scope child cancelled'))
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    child.on('message', message => { Promise.resolve().then(() => onMessage(message, child)).catch(error => stop(error)) })
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxOutput) stop(Error('scope child output budget exhausted'))
      else { try { onOutput(chunk, stream === child.stderr) } catch (error) { stop(error) } }
    })
    child.once('error', error => stop(error))
    child.once('close', (code, signalName) => {
      settled = true;clearTimeout(timer);clearTimeout(grace);clearTimeout(soft);signal?.removeEventListener('abort', cancel)
      if (failure || code !== 0) reject(failure ?? Error(`scope child failed: ${code ?? signalName}`))
      else resolve({ code, bytes })
    })
  })
}

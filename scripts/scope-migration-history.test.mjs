import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { alreadyApplied, APPLICATION_BASELINE, MIGRATION_EQUIVALENTS } from './migration-order.mjs'
import { SCOPE_MIGRATION_IDENTITIES as identities, scopeMigrationBeforeCommit, validateScopeMigrationHistory, validateScopeMigrationSources } from './scope-migration-history.mjs'

const sources = identities.map(identity => ({ ...identity, sql: readFileSync(new URL(`../drizzle/${identity.name}`, import.meta.url), 'utf8') }))
const plan = (applied, files = sources) => {
  validateScopeMigrationHistory(files, applied)
  return files.filter(file => !alreadyApplied(file.name, applied, file.sql)).map(file => file.name)
}

test('scope aliases pin identical SQL and keep the two-body historical name ambiguous', () => {
  for (const file of sources) {
    assert.equal(createHash('sha256').update(file.sql).digest('hex'), file.sha256)
    assert.match(file.sql.replace(/^--[^\n]*\n/gm, '').trimStart(), /^begin;/i)
    assert.equal((file.sql.match(/\bcommit;/ig) ?? []).length, 1)
    assert.equal(scopeMigrationBeforeCommit(file.name, file.sql) + 'commit;\n', file.sql)
    assert.equal(alreadyApplied(file.name, new Set([file.integratedFrom]), file.sql), true)
    assert.equal(alreadyApplied(file.name, new Set([file.previous]), file.sql), true)
    assert.equal(alreadyApplied(file.name, new Set([file.earlier]), file.sql), true)
    if (file.ambiguousOldHashes) {
      assert.deepEqual(MIGRATION_EQUIVALENTS[file.name], [file.integratedFrom, file.previous, file.earlier])
      const earlier = file.sql.replace(/-- Preserve old jobs while revoking claims[\s\S]*(?=commit;)/, '')
      assert.equal(createHash('sha256').update(earlier).digest('hex'), file.ambiguousOldHashes[0])
      assert.throws(() => alreadyApplied(file.name, new Set([file.old]), file.sql), /ambiguous scope migration/)
    } else {
      assert.deepEqual(MIGRATION_EQUIVALENTS[file.name], [file.integratedFrom, file.previous, file.earlier, file.old])
      assert.equal(alreadyApplied(file.name, new Set([file.old]), file.sql), true)
    }
    for (const ledger of [new Set(), new Set([file.old]), new Set([file.integratedFrom, file.previous, file.earlier]), new Set([file.name])])
      assert.throws(() => alreadyApplied(file.name, ledger, file.sql + ' '), /content changed/)
    assert.equal(alreadyApplied(file.name, new Set([file.old + '.unknown']), file.sql), false)
  }
})

test('all partial and mixed ledger models either preserve ordered progress or fail closed', () => {
  const groups = ['MIKKA_DATABASE_URL', 'DATABASE_URL'].map(target => sources.filter(file => file.target === target))
  for (const mode of ['canonical', 'integrated', 'previous', 'earlier', 'historical', 'mixed', 'both', 'all']) {
    for (let mask = 0; mask < 1 << sources.length; mask++) {
      const ledger = new Set()
      sources.forEach((file, index) => {
        if (!(mask & (1 << index))) return
        if (['canonical','both','all'].includes(mode) || (mode === 'mixed' && index % 3 === 0)) ledger.add(file.name)
        if (['integrated','all'].includes(mode)) ledger.add(file.integratedFrom)
        if (['previous','all'].includes(mode) || (mode === 'mixed' && index % 3 === 1)) ledger.add(file.previous)
        if (['earlier','all'].includes(mode)) ledger.add(file.earlier)
        if (['historical','both','all'].includes(mode) || (mode === 'mixed' && index % 3 === 2)) ledger.add(file.old)
      })
      const before = [...ledger]
      const present = file => ledger.has(file.name) || ledger.has(file.integratedFrom) || ledger.has(file.previous) || ledger.has(file.earlier) || ledger.has(file.old)
      const hole = groups.some(group => group.some((file, index) => present(file) && group.slice(0, index).some(earlier => !present(earlier))))
      const ambiguous = sources.some(file => file.ambiguousOldHashes && ledger.has(file.old) && !ledger.has(file.name) && !ledger.has(file.integratedFrom) && !ledger.has(file.previous) && !ledger.has(file.earlier))
      if (hole || ambiguous) assert.throws(() => plan(ledger), /history has a gap|ambiguous scope migration/)
      else assert.deepEqual(plan(ledger), sources.filter(file => !present(file)).map(file => file.name))
      assert.deepEqual([...ledger], before, 'planning never backfills or rewrites ledger identities')
    }
  }
})

test('a later recorded gate cannot prove which older verified-target body ran', () => {
  assert.throws(() => plan(new Set(sources.map(file => file.old))), /ambiguous scope migration/)
  const ledger = new Set(sources.map(file => file.name))
  ledger.delete(sources[0].name)
  assert.throws(() => plan(ledger), /history has a gap/)
  assert.throws(() => plan(new Set(), sources.slice(1)), /source missing/)
  assert.throws(() => validateScopeMigrationSources(sources.filter(file => file.target !== 'DATABASE_URL')), /source missing/)
  assert.throws(() => validateScopeMigrationSources([]), /source missing/)
  assert.equal(scopeMigrationBeforeCommit('unrelated.sql', 'begin;select 1;commit;'), null)
})

// Execute the actual entrypoint against an in-memory ledger/transaction model.
// Only the entrypoint's pg/fs imports are substituted. No sockets, databases,
// fixture directories, credentials, file writes or filesystem cleanup occur.
const entry = new URL('./migrate.mjs', import.meta.url)
const fixtureFiles = new Map(sources.map(file => [file.name, file.sql]))
fixtureFiles.set(APPLICATION_BASELINE, readFileSync(new URL(`../drizzle/${APPLICATION_BASELINE}`, import.meta.url), 'utf8'))
let invocation = 0
async function runEntrypoint(model) {
  const environment = { MIGRATE: '1', VERCEL_ENV: '', MIKKA_DATABASE_URL: 'postgres://127.0.0.1/scope-memory-app', DATABASE_URL: 'postgres://127.0.0.1/scope-memory-workspace' }
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  const oldLog = console.log
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const fromEntry = context.parentURL && new URL(context.parentURL).pathname === entry.pathname
      if (specifier === 'pg') {
        assert.ok(fromEntry, 'pure migration test refuses any uninstrumented pg import')
        return { url: 'scope-history-test:pg', shortCircuit: true }
      }
      if (fromEntry && specifier === 'node:fs') return { url: 'scope-history-test:fs', shortCircuit: true }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url === 'scope-history-test:pg') return { format: 'module', source: 'export class Pool {constructor(options){return globalThis.scopeMigrationHistoryModel.pool(options.connectionString)}}', shortCircuit: true }
      if (url === 'scope-history-test:fs') return { format: 'module', source: 'export const readdirSync=()=>[...globalThis.scopeMigrationHistoryModel.files.keys()];export const readFileSync=url=>globalThis.scopeMigrationHistoryModel.files.get(new URL(url).pathname.split("/").pop())', shortCircuit: true }
      return next(url, context)
    },
  })
  globalThis.scopeMigrationHistoryModel = model
  Object.assign(process.env, environment)
  console.log = (...args) => model.logs.push(args.join(' '))
  const specifier = new URL(entry)
  invocation += 1
  specifier.searchParams.set('scope-history-model', String(invocation))
  try { await import(specifier.href) }
  finally {
    hook.deregister();console.log = oldLog
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function modelFor(app = [], workspace = [], fault = {}) {
  const model = { files: fixtureFiles, logs: [], commits: [], ddl: [], app: new Set([APPLICATION_BASELINE, ...app]), workspace: new Set(workspace), fault }
  model.pool = target => {
    assert.ok(['postgres://127.0.0.1/scope-memory-app', 'postgres://127.0.0.1/scope-memory-workspace'].includes(target))
    const ledger = target === 'postgres://127.0.0.1/scope-memory-app' ? model.app : model.workspace
    return {
      async query(sql) {
        if (sql.startsWith('create table if not exists schema_migrations')) return {}
        assert.equal(sql, 'select name from schema_migrations')
        return { rows: [...ledger].map(name => ({ name })) }
      },
      async connect() {
        let staged
        return {
          async query(sql, params) {
            if (sql === 'ROLLBACK') { staged = undefined;return {} }
            if (sql === 'COMMIT') {
              assert.ok(staged?.ledger, 'DDL and ledger must commit together')
              model.ddl.push(staged.name);ledger.add(staged.ledger);model.commits.push(staged.name)
              const name = staged.name;staged = undefined
              if (model.fault.commitLost === name) { delete model.fault.commitLost;throw new Error('synthetic committed response lost') }
              return {}
            }
            if (sql.startsWith('insert into schema_migrations')) {
              assert.ok(staged, 'scope ledger insertion must be inside the DDL transaction')
              if (model.fault.ledger === params[0]) throw new Error('synthetic ledger failure')
              staged.ledger = params[0];assert.equal(staged.name, params[0]);return {}
            }
            const file = sources.find(file => scopeMigrationBeforeCommit(file.name, file.sql) === sql)
            assert.ok(file, 'only hash-pinned scope DDL before COMMIT can reach the model')
            assert.equal(staged, undefined);staged = { name: file.name };return {}
          },
          release() {},
        }
      },
      async end() {},
    }
  }
  return model
}

test('actual runner model skips old DDL, applies only missing suffixes, and replays nothing on retry', async () => {
  const app = sources.filter(file => file.target === 'MIKKA_DATABASE_URL')
  const workspace = sources.filter(file => file.target === 'DATABASE_URL')
  const model = modelFor(app.slice(0, 5).map(file => file.old), [workspace[0].old])
  await runEntrypoint(model)
  assert.deepEqual(model.ddl, [...app.slice(5), workspace[1]].map(file => file.name))
  for (const file of app.slice(0, 5)) { assert.ok(model.app.has(file.old));assert.equal(model.app.has(file.name), false) }
  const first = [...model.ddl]
  await runEntrypoint(model)
  assert.deepEqual(model.ddl, first)
})

test('renamed scope sources preserve the complete previous ledger without DDL or replacement entries',async()=>{
  const app=sources.filter(file=>file.target==='MIKKA_DATABASE_URL').map(file=>file.previous)
  const workspace=sources.filter(file=>file.target==='DATABASE_URL').map(file=>file.previous)
  const model=modelFor(app,workspace),before={app:[...model.app],workspace:[...model.workspace]}
  await runEntrypoint(model)
  assert.deepEqual(model.ddl,[]);assert.deepEqual(model.commits,[])
  assert.deepEqual({app:[...model.app],workspace:[...model.workspace]},before)
  assert.deepEqual(plan(new Set([...app,...workspace])),[])
})

test('mixed previous and oldest unambiguous prefixes execute only the missing suffix',async()=>{
  const app=sources.filter(file=>file.target==='MIKKA_DATABASE_URL'),workspace=sources.filter(file=>file.target==='DATABASE_URL')
  const prefix=app.slice(0,5).map((file,index)=>index%2?file.old:file.previous)
  const model=modelFor(prefix,[workspace[0].previous])
  await runEntrypoint(model)
  assert.deepEqual(model.ddl,[...app.slice(5),workspace[1]].map(file=>file.name))
  for(const name of prefix)assert.ok(model.app.has(name))
  const before={app:[...model.app],workspace:[...model.workspace],ddl:[...model.ddl]}
  await runEntrypoint(model)
  assert.deepEqual({app:[...model.app],workspace:[...model.workspace],ddl:[...model.ddl]},before)
  const gap=modelFor([app[1].previous])
  await assert.rejects(runEntrypoint(gap),/history has a gap/);assert.deepEqual(gap.ddl,[])
})

test('actual runner model refuses ambiguous, gapped or changed history before pending DDL', async () => {
  const app = sources.filter(file => file.target === 'MIKKA_DATABASE_URL')
  for (const ledger of [app.map(file => file.old), [app[1].old]]) {
    const model = modelFor(ledger)
    await assert.rejects(runEntrypoint(model), /ambiguous scope migration|history has a gap/)
    assert.deepEqual(model.ddl, []);assert.deepEqual(model.commits, [])
  }
  const model = modelFor()
  model.files = new Map(fixtureFiles);model.files.set(sources[0].name, sources[0].sql + ' ')
  await assert.rejects(runEntrypoint(model), /content changed/)
  assert.deepEqual(model.ddl, [])
  const workspaceGap = modelFor([], [sources.at(-1).old])
  await assert.rejects(runEntrypoint(workspaceGap), /history has a gap/)
  assert.deepEqual(workspaceGap.ddl, [], 'workspace preflight must run before the first app migration')
  const missingWorkspace = modelFor()
  missingWorkspace.files = new Map([...fixtureFiles].filter(([name]) => !sources.some(file => file.name === name && file.target === 'DATABASE_URL')))
  await assert.rejects(runEntrypoint(missingWorkspace), /source missing/)
  assert.deepEqual(missingWorkspace.ddl, [])
})

test('actual runner model rolls back DDL when the ledger write fails', async () => {
  const model = modelFor([], [], { ledger: sources[0].name })
  await assert.rejects(runEntrypoint(model), /synthetic ledger failure/)
  assert.deepEqual(model.ddl, []);assert.deepEqual(model.commits, [])
  assert.equal(model.app.has(sources[0].name), false)
})

test('an unrelated AgentKit ledger addition from 79 to 80 neither authorizes nor aliases scope DDL', async () => {
  // Synthetic names model a ledger size, not the contents of the production DB.
  // The actual AgentKit migration belongs to its owner and is not a scope source.
  const unrelated = Array.from({length:78}, (_, index) => `synthetic-retained-${index}.sql`)
  const model = modelFor(unrelated)
  assert.equal(model.app.size,79)
  const before = plan(model.app)
  const agentKit = '20261027181000_agent_kit.sql'
  model.app.add(agentKit)
  assert.equal(model.app.size,80)
  assert.deepEqual(plan(model.app),before)
  const retained = [...model.app]
  await runEntrypoint(model)
  assert.deepEqual(model.ddl,['MIKKA_DATABASE_URL','DATABASE_URL'].flatMap(target=>sources.filter(file=>file.target===target).map(file=>file.name)))
  for(const name of retained)assert.ok(model.app.has(name))
  assert.equal(model.ddl.includes(agentKit),false)

  const ambiguous=modelFor([...unrelated,agentKit,...sources.filter(file=>file.target==='MIKKA_DATABASE_URL').map(file=>file.old)])
  const unchanged=[...ambiguous.app]
  await assert.rejects(runEntrypoint(ambiguous),/ambiguous scope migration/)
  assert.deepEqual(ambiguous.ddl,[])
  assert.deepEqual([...ambiguous.app],unchanged)
})

test('actual runner model retains both DDL and ledger after lost COMMIT response; retry does not repeat it', async () => {
  const model = modelFor([], [], { commitLost: sources[0].name })
  await assert.rejects(runEntrypoint(model), /synthetic committed response lost/)
  assert.deepEqual(model.ddl, [sources[0].name]);assert.ok(model.app.has(sources[0].name))
  await runEntrypoint(model)
  assert.equal(model.ddl.filter(name => name === sources[0].name).length, 1)
  assert.equal(model.ddl.length, sources.length)
})

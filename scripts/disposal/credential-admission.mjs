// One synthetic executor cycle. No signal, browser launch, unlink or recursive removal.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const project = fileURLToPath(new URL('../../', import.meta.url))
const modulePath = fileURLToPath(import.meta.url)
const pwRoot = dirname(require.resolve('playwright-core/package.json'))
const sha = value => createHash('sha256').update(value).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const frozenFiles = ['scripts/disposal/credential-admission.mjs', 'lib/credentials/acceptance-lifecycle.ts', 'lib/credentials/owned-chromium.ts', 'lib/credentials/contracts.ts', 'lib/credentials/browser-protocol.ts', 'lib/credentials/acceptance-resource-registry.ts', 'package.json', 'pnpm-lock.yaml']
export function runtimeSourceDigest(root) {
  const files = []
  const visit = (relative = '') => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = join(relative, name), st = lstatSync(join(root, path))
      assert.ok(!st.isSymbolicLink(), 'runtime source symlink refused')
      if (st.isDirectory()) visit(path)
      else { assert.ok(st.isFile()); files.push([path, sha(readFileSync(join(root, path)))]) }
    }
  }
  visit()
  return sha(JSON.stringify(files))
}
export function sourceIdentity() {
  assert.equal(json(join(pwRoot, 'package.json')).version, '1.64.1')
  return sha(JSON.stringify({ runtime: process.version, files: frozenFiles.map(path => [path, sha(readFileSync(join(project, path)))]), playwright: runtimeSourceDigest(pwRoot), node: sha(readFileSync(process.execPath)) }))
}
export function procIdentity(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8'), f = text.slice(text.lastIndexOf(')') + 2).split(/\s+/)
  assert.ok(/^\d+$/.test(f[19]))
  const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
  assert.ok(uid)
  const again = readFileSync(`/proc/${pid}/stat`, 'utf8'), next = again.slice(again.lastIndexOf(')') + 2).split(/\s+/)
  for (const index of [1, 2, 3, 19]) assert.equal(next[index], f[index], 'process changed during observation')
  return { pid, ppid: Number(f[1]), pgid: Number(f[2]), sid: Number(f[3]), starttime: f[19], uid: Number(uid[1]) }
}
function privateFile(path) {
  const s = lstatSync(path)
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0, 'private owned evidence required')
}
function directory(identity) {
  assert.equal(realpathSync(identity.path), identity.path)
  const s = lstatSync(identity.path)
  assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o077) === 0)
  assert.equal(String(s.dev), identity.dev); assert.equal(String(s.ino), identity.ino)
}
function evidence(path) { privateFile(path); return json(path) }
function save(path, value) { writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 }) }
function rolePlan(plan, role) { const item = plan.sessions.find(s => s.role === role); assert.ok(item, 'unknown session role'); return item }
function exactHost(plan) { assert.deepEqual(procIdentity(process.pid), plan.host, 'different execution host') }
// Structural checks survive an already-removed session; live identity checks happen
// separately at prepare/admission. Never let a reservation name address the registry.
function reservationScope(root, registry, reservations) {
  const identities = new Set([`${registry.dev}:${registry.ino}`])
  const paths = new Set([root])
  for (const r of reservations) {
    assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'UUID v4 reservation required')
    assert.equal(r.directory, join(root, r.id))
    assert.equal(dirname(r.directory), root, 'direct child required')
    assert.notEqual(r.directory, root)
    assert.equal(r.profile, join(r.directory, 'profile'))
    assert.equal(r.artifacts, join(r.directory, 'artifacts'))
    assert.deepEqual(r.directories.map(d => d.path), [r.directory, r.profile, r.artifacts])
    for (const d of r.directories) {
      assert.ok(!paths.has(d.path), 'reservation path alias')
      assert.ok(!identities.has(`${d.dev}:${d.ino}`), 'reservation inode alias')
      paths.add(d.path); identities.add(`${d.dev}:${d.ino}`)
    }
  }
}
function checkPlan(plan) {
  assert.ok(['executor-positive-once', 'contract-fixture'].includes(plan.kind))
  assert.equal(plan.registry.path, plan.root)
  assert.equal(plan.executable, plan.kind === 'contract-fixture' ? join(plan.root, 'fixture-target') : '/usr/lib/chromium/chromium')
  assert.equal(plan.version, 1); assert.equal(plan.uid, process.getuid()); assert.equal(plan.source, sourceIdentity())
  assert.equal(plan.calls, 2); assert.equal(plan.startsPerCall, 2); assert.equal(plan.maxStarts, 4)
  assert.deepEqual(plan.sessions.map(s => s.role), ['initial', 'replacement'])
  directory(plan.registry)
  reservationScope(plan.root, plan.registry, plan.sessions)
  privateFile(join(plan.root, 'owner.json'))
  assert.equal(sha(readFileSync(join(plan.root, 'owner.json'))), plan.ownerHash)
  assert.equal(sha(readFileSync(plan.executable)), plan.executableHash)
  for (const s of plan.sessions) {
    assert.equal(s.directory, join(plan.root, s.id)); assert.equal(s.profile, join(s.directory, 'profile')); assert.equal(s.artifacts, join(s.directory, 'artifacts'))
    assert.deepEqual(s.directories.map(d => d.path), [s.directory, s.profile, s.artifacts])
    privateFile(s.wrapper)
    assert.equal(sha(readFileSync(s.wrapper)), s.wrapperHash)
  }
  assert.notEqual(plan.sessions[0].id, plan.sessions[1].id)
}
export function prepareAdmission(root, binding, reservations, executable, kind = 'executor-positive-once') {
  assert.ok(['executor-positive-once', 'contract-fixture'].includes(kind))
  assert.equal(realpathSync(root), root); assert.equal(reservations.length, 2)
  if (kind === 'executor-positive-once') assert.equal(executable, '/usr/lib/chromium/chromium')
  else assert.equal(executable, join(root, 'fixture-target'))
  const owner = json(join(root, 'owner.json')), st = lstatSync(root)
  assert.equal(owner.root, root); assert.equal(owner.uid, process.getuid())
  reservationScope(root, { dev: String(st.dev), ino: String(st.ino) }, reservations)
  for (const r of reservations) for (const d of r.directories) directory(d)
  const roles = ['initial', 'replacement']
  const sessions = reservations.map((r, index) => {
    assert.equal(r.directory, join(root, r.id))
    for (const d of r.directories) directory(d)
    const role = roles[index], wrapper = join(root, `${role}-exec.sh`)
    const code = `#!/bin/sh\n${quote(process.execPath)} ${quote(modulePath)} preflight ${quote(join(root, 'lifecycle-manifest.json'))} ${quote(role)} "$$" "$@" || exit 78\nexec ${quote(executable)} "$@"\n`
    writeFileSync(wrapper, code, { flag: 'wx', mode: 0o700 })
    return { ...r, role, wrapper, wrapperHash: sha(code) }
  })
  const plan = { version: 1, kind, nonce: randomUUID(), root, uid: process.getuid(), host: procIdentity(process.pid), binding: structuredClone(binding), registry: { path: root, dev: String(st.dev), ino: String(st.ino) }, ownerHash: sha(readFileSync(join(root, 'owner.json'))), source: sourceIdentity(), executable, executableHash: sha(readFileSync(executable)), calls: 2, startsPerCall: 2, maxStarts: 4, sessions }
  checkPlan(plan)
  save(join(root, 'lifecycle-manifest.json'), plan)
  return { plan, manifestHash: sha(readFileSync(join(root, 'lifecycle-manifest.json'))) }
}
function approval(plan) {
  assert.deepEqual(evidence(join(plan.root, 'lifecycle-manifest.json')), plan, 'frozen manifest changed')
  const path = join(plan.root, 'approval.json'); privateFile(path)
  const a = json(path)
  assert.equal(a.decision, 'approve-single-synthetic-cycle')
  assert.equal(a.manifestHash, sha(readFileSync(join(plan.root, 'lifecycle-manifest.json'))))
  assert.equal(a.nonce, plan.nonce); assert.equal(a.source, plan.source); assert.equal(a.maxStarts, 4)
  assert.equal(a.maxSessionRootsRemoved, 2); assert.equal(a.maxDatabaseRowsDeleted, 0)
  assert.equal(a.implicitTermination, 'only-owned-wrapper-groups-including-preflight-startup-timeout-host-exit')
  assert.equal(a.retainRegistryEvidence, true)
  assert.ok(typeof a.authorizationReference === 'string' && a.authorizationReference.length > 0)
  return { a, hash: sha(readFileSync(path)) }
}
export function admitRun(plan, binding) {
  // Resource-contract setup alone does not freeze the executing scenario. Until
  // a reviewed entry/config is implemented and pinned, real execution is refused.
  assert.equal(plan.kind, 'contract-fixture', 'actual lifecycle runner and scenario are not frozen; setup-only')
  checkPlan(plan); exactHost(plan); assert.deepEqual(binding, plan.binding)
  const { a, hash } = approval(plan)
  assert.ok(Number.isFinite(Date.parse(a.launchExpiresAt)) && Date.parse(a.launchExpiresAt) > Date.now(), 'approval expired')
  for (const s of plan.sessions) for (const d of s.directories) directory(d)
  save(join(plan.root, 'run-consumed.json'), { nonce: plan.nonce, approvalHash: hash, source: plan.source, host: plan.host })
}
function grant(plan, launching) {
  assert.equal(plan.kind, 'contract-fixture', 'actual lifecycle runner and scenario are not frozen; setup-only')
  checkPlan(plan)
  const { a, hash } = approval(plan), receipt = evidence(join(plan.root, 'run-consumed.json'))
  assert.equal(receipt.nonce, plan.nonce); assert.equal(receipt.approvalHash, hash); assert.equal(receipt.source, plan.source); assert.deepEqual(receipt.host, plan.host)
  if (launching) assert.ok(Date.parse(a.launchExpiresAt) > Date.now(), 'launch window expired')
}
export function admitCall(plan, role, binding) {
  grant(plan, true); exactHost(plan); assert.deepEqual(binding, plan.binding)
  const s = rolePlan(plan, role)
  for (const d of s.directories) directory(d)
  if (role === 'replacement') {
    assert.deepEqual(evidence(join(plan.root, 'initial-cleanup-admitted.json')), { nonce: plan.nonce, role: 'initial', directory: plan.sessions[0].directory }, 'initial cleanup not admitted')
    assert.equal(existsSync(plan.sessions[0].directory), false, 'initial session still exists')
    assertNoLiveGroups(plan, 'initial')
  }
  save(join(plan.root, `${role}-call.json`), { nonce: plan.nonce, role, host: plan.host })
  return { executablePath: s.wrapper, env: {} }
}
function starts(plan, role) {
  return [1, 2].map(n => join(plan.root, `${role}-spawn-${n}.json`)).filter(existsSync).map(evidence)
}
function groupMembers(pgid) {
  const rows = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) <= 1) continue
    try { const p = procIdentity(Number(name)); if (p.pgid === pgid) rows.push(p) } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e }
  }
  return rows
}
function assertNoLiveGroups(plan, role) { for (const record of starts(plan, role)) assert.equal(groupMembers(record.process.pgid).length, 0, 'prior group remains') }
// Also used by non-browser contract tests with explicit fixture identities.
export function admitSpawn(plan, role, identity, args, fixture = false) {
  grant(plan, true)
  const s = rolePlan(plan, role); assert.equal(evidence(join(plan.root, `${role}-call.json`)).nonce, plan.nonce)
  for (const d of s.directories) directory(d)
  assert.equal(identity.ppid, plan.host.pid); assert.equal(identity.uid, plan.uid)
  assert.equal(identity.pgid, identity.pid); assert.equal(identity.sid, identity.pid)
  assert.match(identity.starttime, /^\d+$/)
  assert.deepEqual(args.filter(a => a.startsWith('--user-data-dir=')), [`--user-data-dir=${s.profile}`])
  if (fixture) assert.equal(plan.kind, 'contract-fixture')
  else {
    assert.equal(process.ppid, identity.pid, 'checker must be a direct child of its wrapper')
    assert.deepEqual(procIdentity(identity.pid), identity)
    const host = procIdentity(plan.host.pid); assert.deepEqual(host, plan.host)
    const wrapperArgs = readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    const position = wrapperArgs.indexOf(s.wrapper); assert.ok(position >= 0, 'unexpected wrapper command')
    assert.deepEqual(wrapperArgs.slice(position + 1), args)
    if (plan.kind === 'executor-positive-once') { assert.ok(args.includes('--remote-debugging-pipe')); assert.ok(!args.some(a => a.startsWith('--remote-debugging-port') || a === '--user-data-dir')) }
  }
  const previous = starts(plan, role)
  assert.ok(previous.length < 2, 'native retry budget exhausted')
  if (!fixture && previous.length) assertNoLiveGroups(plan, role)
  const attempt = previous.length + 1
  save(join(plan.root, `${role}-spawn-${attempt}.json`), { nonce: plan.nonce, role, attempt, process: identity, argsHash: sha(JSON.stringify(args)), profile: s.profile })
  return attempt
}
export function admitCleanup(plan, role, binding) {
  grant(plan, false); exactHost(plan); assert.deepEqual(binding, plan.binding)
  const s = rolePlan(plan, role); assert.equal(evidence(join(plan.root, `${role}-call.json`)).nonce, plan.nonce)
  for (const d of s.directories) directory(d)
  const records = starts(plan, role)
  assert.ok(records.length > 0, 'unrecorded startup is uncertain; retain session')
  for (const record of records) {
    try { assert.deepEqual(procIdentity(record.process.pid), record.process, 'process identity changed') }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e }
    for (const member of groupMembers(record.process.pgid)) { assert.equal(member.sid, record.process.sid); assert.equal(member.uid, plan.uid) }
  }
  const path = join(plan.root, `${role}-cleanup-admitted.json`)
  const receipt = { nonce: plan.nonce, role, directory: s.directory }
  if (!existsSync(path)) save(path, receipt)
  else assert.deepEqual(evidence(path), receipt)
  return { authorized: true, directory: s.directory }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(modulePath)) {
  try {
    assert.equal(process.argv[2], 'preflight')
    const plan = evidence(process.argv[3]), role = process.argv[4], pid = Number(process.argv[5])
    assert.equal(process.argv[3], join(plan.root, 'lifecycle-manifest.json'))
    admitSpawn(plan, role, procIdentity(pid), process.argv.slice(6))
  } catch { console.error('synthetic browser admission refused'); process.exitCode = 78 }
}

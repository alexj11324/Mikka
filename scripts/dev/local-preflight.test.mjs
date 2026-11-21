import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { argsFrom, changesFromGit, evidenceIdentity, localTaskPlan, readiness, runScript } from './local-preflight.mjs'

const runGit = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'mikka-local-first-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  runGit(cwd, 'init', '--quiet')
  runGit(cwd, 'config', 'user.name', 'Mikka Test')
  runGit(cwd, 'config', 'user.email', 'mikka-test@example.invalid')
  writeFileSync(join(cwd, 'first.ts'), 'export const number = 1\n')
  runGit(cwd, 'add', '.')
  runGit(cwd, 'commit', '--quiet', '-m', 'baseline')
  runGit(cwd, 'branch', '-M', 'main')
  const base = runGit(cwd, 'rev-parse', 'HEAD')
  runGit(cwd, 'checkout', '--quiet', '-b', 'feature')
  return { cwd, base }
}

test('preflight has explicit operation and script flags', () => {
  const x = argsFrom(['ready', '--base=main', '--test=test:groups', '--test=test:ui-policy', '--accept=test:local-loop'])
  assert.equal(x.command, 'ready')
  assert.deepEqual(x.tests, ['test:groups', 'test:ui-policy'])
  assert.equal(x.accept, 'test:local-loop')
  assert.throws(() => argsFrom(['ready', '--accept=test:local-loop', '--no-product-change=docs: no runtime change']), /Cannot waive/)
  assert.throws(() => argsFrom(['--whatever']), /Unknown option/)
})

test('diff includes committed, staged, unstaged and untracked changes, but not ignored artifacts', t => {
  const { cwd, base } = repo(t)
  writeFileSync(join(cwd, 'first.ts'), 'export const number = 2\n')
  runGit(cwd, 'add', 'first.ts')
  runGit(cwd, 'commit', '--quiet', '-m', 'change')
  writeFileSync(join(cwd, 'unstaged.ts'), 'export {}\n')
  writeFileSync(join(cwd, 'staged.ts'), 'export {}\n')
  runGit(cwd, 'add', 'staged.ts')
  writeFileSync(join(cwd, '.gitignore'), '.cache/\n')
  mkdirSync(join(cwd, '.cache'))
  writeFileSync(join(cwd, '.cache', 'generated.json'), '{}')
  const x = changesFromGit(cwd, base)
  assert.deepEqual(x.changes.map(v => v.path), ['.gitignore', 'first.ts', 'staged.ts', 'unstaged.ts'])
  assert.equal(x.clean, false)
  assert.equal(x.base, base)
})

test('preflight refuses absent trusted diff base', t => {
  const { cwd } = repo(t)
  assert.throws(() => changesFromGit(cwd, 'origin/main'), /git rev-parse failed/)
})

test('clean change has stable identity and preserves exact HEAD', t => {
  const { cwd, base } = repo(t)
  writeFileSync(join(cwd, 'new-file.ts'), 'export {}\n')
  runGit(cwd, 'add', '.')
  runGit(cwd, 'commit', '--quiet', '-m', 'changed')
  const one = changesFromGit(cwd, base)
  assert.equal(one.clean, true)
  assert.notEqual(one.head, one.base)
  assert.equal(evidenceIdentity(one), evidenceIdentity(changesFromGit(cwd, base)))
})

test('native executable modes survive committed, staged and unstaged diffs', t => {
  for (const phase of ['committed', 'staged', 'unstaged']) {
    const { cwd, base } = repo(t)
    chmodSync(join(cwd, 'first.ts'), 0o755)
    if (phase !== 'unstaged') runGit(cwd, 'add', 'first.ts')
    if (phase === 'committed') runGit(cwd, 'commit', '--quiet', '-m', 'executable input')
    const change = changesFromGit(cwd, base).changes.find(item => item.path === 'first.ts')
    assert.equal(change.status, 'M', phase)
    assert.equal(change.oldMode, '100644', phase)
    assert.equal(change.mode, '100755', phase)
    assert.match(change.oldObject, /^[a-f\d]{40}$/)
    assert.match(change.newObject, /^[a-f\d]{40}$/)
  }
})

test('new symlinks and executable files keep their actual type without following links', t => {
  for (const staged of [false, true]) {
    const { cwd, base } = repo(t)
    symlinkSync('missing-target.ts', join(cwd, 'linked file.ts'))
    writeFileSync(join(cwd, 'executable file.ts'), 'export {}\n', { mode: 0o755 })
    if (staged) runGit(cwd, 'add', 'linked file.ts', 'executable file.ts')
    const changes = changesFromGit(cwd, base).changes
    assert.equal(changes.find(item => item.path === 'linked file.ts').mode, '120000')
    assert.equal(changes.find(item => item.path === 'executable file.ts').mode, '100755')
    assert(changes.every(item => item.status === 'A' && item.oldMode === '000000'))
  }
})

test('a later regular content edit cannot erase earlier Git mode changes', t => {
  const { cwd, base } = repo(t)
  chmodSync(join(cwd, 'first.ts'), 0o755)
  runGit(cwd, 'add', 'first.ts')
  runGit(cwd, 'commit', '--quiet', '-m', 'executable input')
  chmodSync(join(cwd, 'first.ts'), 0o644)
  runGit(cwd, 'add', 'first.ts')
  writeFileSync(join(cwd, 'first.ts'), 'export const number = 2\n')
  assert.deepEqual(changesFromGit(cwd, base).changes.map(item => [item.oldMode, item.mode]), [
    ['100644', '100755'], ['100755', '100644'], ['100644', '100644'],
  ])
})

test('deletion remains visible when an untracked path reappears and newline paths fail closed', t => {
  const { cwd, base } = repo(t)
  runGit(cwd, 'rm', 'first.ts')
  runGit(cwd, 'commit', '--quiet', '-m', 'remove tracked input')
  writeFileSync(join(cwd, 'first.ts'), 'export {}\n')
  assert(changesFromGit(cwd, base).changes.some(item => item.path === 'first.ts' && item.status === 'D'))
  writeFileSync(join(cwd, 'unexpected\npath.ts'), 'export {}\n')
  assert.throws(() => changesFromGit(cwd, base), /Newline paths require explicit review/)
})

test('mode changes are part of the exact local evidence identity', t => {
  const { cwd, base } = repo(t)
  chmodSync(join(cwd, 'first.ts'), 0o755)
  const executable = changesFromGit(cwd, base)
  chmodSync(join(cwd, 'first.ts'), 0o644)
  writeFileSync(join(cwd, 'first.ts'), 'export const number = 2\n')
  const regular = changesFromGit(cwd, base)
  assert.equal(executable.head, regular.head)
  assert.deepEqual(executable.changes.map(item => item.path), regular.changes.map(item => item.path))
  assert.notEqual(evidenceIdentity(executable), evidenceIdentity(regular))
})

test('Nx suggested tests are affected-only, mandatory broad tasks stay for final CI', () => {
  const plan = localTaskPlan({ files: ['components/view.tsx'], scripts: { 'test:groups': 'node --test a.test.mjs' },
    unit_tasks: [{ project: 'ci-core-9', command: 'pnpm test:groups', reason: 'Nx reverse dependency' },
      { project: 'ci-core-10', command: 'pnpm test:ui-policy', reason: 'mandatory source/security policy' }], db_suites: [] })
  assert.deepEqual(plan.suggested, ['pnpm test:groups'])
  assert.deepEqual(plan.relevantUnits, ['ci-core-9'])
  assert(plan.hasBehaviors)
  assert.throws(() => localTaskPlan({ scripts: {}, unit_tasks: [] }, ['does-not-exist']), /Unknown package script/)
})

test('ready blocks failed tests, stale worktrees and absence of product acceptance', () => {
  const plan = localTaskPlan({files:['lib/feature.ts'], unit_tasks:[], scripts:{}, db_suites:[]})
  const outcome = { clean: true, changedFiles:['lib/feature.ts'], checks:[{exitCode:0}], acceptance:{type:'script', exitCode:0} }
  assert.equal(readiness(plan, outcome), true)
  assert.throws(() => readiness(plan, {...outcome, clean:false}), /clean committed/)
  assert.throws(() => readiness(plan, {...outcome, checks:[{exitCode:1}]}), /failed/)
  assert.throws(() => readiness(plan, {...outcome, acceptance:null}), /Provide --accept/)
  assert.throws(() => readiness(plan, {...outcome, checks:[], acceptance:null}, {reason:'tooling: changed checked code'}), /actual focused/)
})

test('explicit non-product waiver is restricted, not accepted for UI behavior', () => {
  const plan = localTaskPlan({files:['components/button.tsx'],scripts:{},db_suites:[]})
  const outcome = {clean:true, changedFiles:['components/button.tsx'], checks:[{exitCode:0}], acceptance:null}
  assert.throws(() => readiness(plan,outcome,{reason:'No need for product acceptance'}), /Behavior-changing code/)
  assert.equal(readiness(plan,outcome,{reason:'tooling: only updates fixture mapping, no UI behavior'}),true)
})

test('existing scripts run without shell interpolation, and failures remain failures', () => {
  let invoked = []
  const executor = (cmd,args,opts) => { invoked.push({cmd,args,shell:opts.shell}); return {status:0} }
  const s = runScript('/tmp', 'test:groups', {'test:groups':'node --test fixture'},executor)
  assert.equal(s.exitCode,0)
  assert.deepEqual(invoked[0],{cmd:'pnpm',args:['run','test:groups'],shell:false})
  assert.equal(runScript('/tmp','test:groups',{'test:groups':'fixture'},()=>({status:1})).exitCode,1)
  assert.throws(()=>runScript('/tmp','test:missing',{},executor),/Unknown script/)
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { main } from './run-units.mjs'
const env = { ...process.env, CI_UNITS:'["ci-core-6"]', FORCE_COLOR:'true' }
test('task children retain plain numeric process output despite inherited Nx color settings', () => {
  const status = main('core',env,(_command,_args,options) => {
    const child = spawnSync(process.execPath,['-e','console.log(4321)'],{env:options.env,encoding:'utf8'})
    assert.equal(child.stdout,'4321\n')
    assert.equal(Number(child.stdout.trim()),4321)
    return child
  })
  assert.equal(status,0)
})
test('a failed, signalled or unspawnable scheduler never passes the unit lane', () => {
  for (const result of [{status:1},{status:null,signal:'SIGTERM'},{status:0,signal:'SIGTERM'},{status:0,error:new Error('spawn failure')}]) assert.equal(main('core',env,()=>result),1)
  assert.throws(()=>main('core',{CI_UNITS:'[]'}),/unitSelectionRequired/)
  assert.throws(()=>main('core',{CI_UNITS:'["ci-unregistered"]'}),/invalidUnitSelection/)
})

test('current and older trusted selectors schedule the docs classifier suite once', () => {
  for (const selection of [['ci-core-6'], ['ci-core-6', 'ci-core-7'], ['ci-core-7'], ['*']]) {
    const result = main('core', { CI_UNITS: JSON.stringify(selection) }, (_command, args) => {
      const targets = args[args.indexOf('-t') + 1].split(',')
      assert.equal(targets.filter(target => target === 'core-7').length, 1)
      assert.ok(!targets.includes('core-6'))
      return { status: 0 }
    })
    assert.equal(result, 0)
  }
})

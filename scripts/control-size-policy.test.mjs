import assert from 'node:assert/strict'
import test from 'node:test'
import { auditControlSizes } from './control-size-policy.mjs'

const audit = code => auditControlSizes('components/example.tsx', code)

for (const code of [
  // The screenshot defect: a 28px button beside a 32px select.
  '<div className="flex items-center gap-2"><Button size="sm">a</Button><NativeSelect aria-label="x" /></div>',
  '<div className="flex flex-wrap items-center gap-2"><Button>a</Button><Button size="sm">b</Button></div>',
  '<div className={cn("flex items-center gap-2")}><Button size="icon-sm" aria-label="x" /><Input /></div>',
  // 36px beside 32px is still two steps.
  '<div className="flex items-center gap-2"><Button size="lg">a</Button><NativeSelect aria-label="x" /></div>',
]) test(`rejects a row mixing control steps: ${code}`, () => assert.equal(audit(code).length, 1))

for (const code of [
  // One step for the whole row.
  '<div className="flex items-center gap-2"><Button size="sm">a</Button><NativeSelect size="sm" aria-label="x" /></div>',
  '<div className="flex items-center gap-2"><Button>a</Button><NativeSelect aria-label="x" /></div>',
  // Vertical stacks share no baseline, so their heights may differ.
  '<div className="flex flex-col gap-2"><Button size="sm">a</Button><NativeSelect aria-label="x" /></div>',
  // A row with a single control.
  '<div className="flex items-center gap-2"><Button size="sm">a</Button></div>',
  // Explicit height classes resolve to the same step as the prop.
  '<div className="flex items-center gap-2"><Button size="sm">a</Button><div className="h-7">x</div></div>',
  // An exempt comment states why.
  '// control-size-exempt: a 32px select is deliberately taller than its caption\n<div className="flex items-center gap-2"><Button size="sm">a</Button><NativeSelect aria-label="x" /></div>',
  '<div className="flex items-center gap-2">{/* control-size-exempt: a calendar popover */}<Button size="sm">a</Button><NativeSelect aria-label="x" /></div>',
]) test(`allows: ${code}`, () => assert.deepEqual(audit(code), []))

test('an exempt comment needs a reason', () => assert.equal(
  audit('// control-size-exempt:\n<div className="flex items-center gap-2"><Button size="sm">a</Button><NativeSelect aria-label="x" /></div>').length,
  1,
))

test('a stack inside a row is not on the row: its controls cannot be misaligned with it', () => {
  const source = `
    export function Panel() {
      return <div className="flex items-center gap-2"><div className="flex flex-col gap-1"><Button size="sm">a</Button><Input /></div></div>
    }`
  assert.deepEqual(audit(source), [])
  const grid = `
    export function Panel() {
      return <div className="flex items-center gap-2"><div className="grid"><Button size="sm">a</Button><Input /></div></div>
    }`
  assert.deepEqual(audit(grid), [])
})

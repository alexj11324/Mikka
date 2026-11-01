import assert from 'node:assert/strict'
import test from 'node:test'
import { auditSplitPanes } from './split-pane-policy.mjs'

const audit = code => auditSplitPanes('components/example.tsx', code)

for (const code of [
  '<aside className="w-64 shrink-0 border-r" />',
  '<aside className="flex lg:w-60 lg:border-l">x</aside>',
  '<div className={cn("hidden shrink-0 border-l xl:flex", open && "w-90")}>x</div>',
  '<div className="md:basis-1/2 border-s">x</div>',
]) test(`rejects a fixed column with its own side line: ${code}`, () => assert.equal(audit(code).length, 1))

for (const code of [
  '<ResizablePane className="w-64 shrink-0 border-r" label="x" />',
  '<div className="shrink-0 border-l"><ResizeHandle resize={r} label="x" edge="start" /></div>',
  '<ol className="ml-1.5 flex flex-col border-l pl-3" />',
  '<div className="flex-1 border-r" />',
  '<div className="w-64 shrink-0 border-b" />',
  '// split-pane-exempt: loading skeleton\n<aside className="w-64 shrink-0 border-r" />',
  '<aside className="w-64 shrink-0 border-r" /> {/* split-pane-exempt: a placeholder */}',
]) test(`allows: ${code}`, () => assert.deepEqual(audit(code), []))

test('an exempt comment needs a reason', () => assert.equal(audit('// split-pane-exempt:\n<aside className="w-64 shrink-0 border-r" />').length, 1))

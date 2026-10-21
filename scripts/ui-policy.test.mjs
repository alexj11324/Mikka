import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { auditSource, auditCss, isComponentLibrarySource, splitUtilities, utilityBase } from './ui-policy.mjs'

const policy = JSON.parse(readFileSync(new URL('../ui-policy.json', import.meta.url), 'utf8'))
const prefix = `import { cn } from '@/lib/utils'; import { Button } from '@/components/ui/button';`
const rules = source => auditSource('components/example.tsx', source, policy).map(d => d.rule)
const has = (source, rule) => assert.ok(rules(source).includes(rule), `${rule}: ${source}`)

for (const [label, source, rule] of [
  ['raw HTML', '<button>Save</button>', 'components/no-handwritten-ui'],
  ['HTML alias', 'const Tag = "button"; const ui = <Tag />', 'components/no-handwritten-ui'],
  ['handwritten input', '<input type="text" />', 'components/no-handwritten-ui'],
  ['handwritten textarea', '<textarea />', 'components/no-handwritten-ui'],
  ['handwritten select', '<select />', 'components/no-handwritten-ui'],
  ['handwritten fieldset', '<fieldset />', 'components/no-handwritten-ui'],
  ['handwritten kbd', '<kbd>K</kbd>', 'components/no-handwritten-ui'],
  ['handwritten details', '<details><summary>x</summary></details>', 'components/no-handwritten-ui'],
  ['handwritten hr', '<hr />', 'components/no-handwritten-ui'],
  ['handwritten label', '<label>x</label>', 'components/no-handwritten-ui'],
  ['handwritten table', '<table />', 'components/no-handwritten-ui'],
  ['handwritten dialog', '<dialog />', 'components/no-handwritten-ui'],
  ['handwritten nav', '<nav />', 'components/no-handwritten-ui'],
  ['handwritten progress', '<progress />', 'components/no-handwritten-ui'],
  ['primitive bypass', 'import { Button } from "@base-ui/react/button"; const ui = <Button />', 'components/no-primitive-bypass'],
  ['factory alias', 'import { createElement as make } from "react"; make("button")', 'components/no-element-factory'],
  ['DOM factory', 'document.createElement("button")', 'components/no-custom-implementation'],
  ['custom variants', 'import { cva } from "class-variance-authority"; cva("bg-muted")', 'components/no-custom-implementation'],
  ['inline style', '<Button style={{ color: "red" }} />', 'style/no-inline-ui'],
  ['inline font', '<Button style={{ fontSize: 13 }} />', 'typography/no-inline-values'],
  ['arbitrary font size', '<Button className="text-[13px]" />', 'typography/preset-only'],
  ['variable font size', '<Button className="text-(length:--size)" />', 'typography/preset-only'],
  ['arbitrary line height', '<Button className="leading-[1.2]" />', 'typography/preset-only'],
  ['non preset font weight', '<Button className="font-extrabold" />', 'typography/preset-only'],
  ['non preset size', '<Button className="text-9xl" />', 'typography/preset-only'],
  ['slash line height', '<Button className="text-sm/13" />', 'typography/preset-only'],
  ['uncheckable classes', '<Button className={getClasses()} />', 'style/static-layout-only'],
  ['raw palette', '<Button className="text-emerald-600" />', 'style/semantic-colors'],
  ['space utility', '<Button className="space-x-2" />', 'style/gap'],
  ['dark color override', '<Button className="dark:bg-muted" />', 'style/no-dark-color-override'],
  ['conditional classes', '<Button className={active ? "flex" : "grid"} />', 'style/use-cn'],
  ['equal dimensions', '<Button className="h-4 w-4" />', 'style/size-shorthand'],
  ['truncate shorthand', '<Button className="overflow-hidden text-ellipsis whitespace-nowrap" />', 'style/truncate'],
  ['overlay stacking', 'import { DialogContent } from "@/components/ui/dialog"; const ui = <DialogContent className="z-50" />', 'style/overlay-stacking'],
  ['aliased menu grouping', 'import { SelectItem as Option } from "@/components/ui/select"; const ui = <Option />', 'composition/group'],
  ['avatar fallback', 'import { Avatar } from "@/components/ui/avatar"; const ui = <Avatar />', 'composition/avatar-fallback'],
  ['accessible title', 'import { DialogContent } from "@/components/ui/dialog"; const ui = <DialogContent />', 'composition/title'],
  ['card structure', 'import { Card, CardContent } from "@/components/ui/card"; const ui = <Card><CardContent /></Card>', 'composition/card'],
  ['loading prop', '<Button isLoading />', 'composition/button-loading'],
  ['Base UI menu events', 'import { DropdownMenuItem } from "@/components/ui/dropdown-menu"; const ui = <DropdownMenuItem onSelect={save} />', 'composition/base-events'],
  ['Base UI render', '<Button asChild />', 'composition/base-render'],
  ['InputGroup control', 'import { InputGroup, Input } from "@/components/ui/input-group"; const ui = <InputGroup><Input /></InputGroup>', 'forms/input-group'],
  ['field grouping', 'import { Field } from "@/components/ui/field"; const ui = <Field />', 'forms/field-group'],
  ['icon component reference', '<Button icon="check" />', 'icons/component-reference'],
  ['button icon metadata', 'import { Check } from "lucide-react"; const ui = <Button><Check /></Button>', 'icons/data-icon'],
  ['icon dimensions', 'import { Check } from "lucide-react"; const ui = <Button><Check data-icon="inline-start" className="size-4" /></Button>', 'icons/no-size-override'],
  ['font family allowlist', 'import { Roboto } from "next/font/google";', 'typography/font-family'],
]) test(label, () => has(`${prefix}\n${source}`, rule))

test('component composition + business data/event wiring + layout are allowed', () => {
  const source = `${prefix}
    import { FieldGroup, Field, FieldLabel } from '@/components/ui/field';
    import { Input } from '@/components/ui/input';
    import { Check } from 'lucide-react';
    const ui = <FieldGroup className={cn('flex gap-4', active && 'grid')}>
      <Field><FieldLabel htmlFor="name">Name</FieldLabel><Input id="name" value={name} onChange={updateName} /></Field>
      <Button variant="outline" size="sm" onClick={save} disabled={pending}>
        <Check data-icon="inline-start" />{title}
      </Button>
    </FieldGroup>`
  assert.deepEqual(rules(source), [])
})

test('valid grouped items + title + avatar', () => {
  const source = `import { SelectGroup, SelectItem } from '@/components/ui/select';
    import { DialogContent, DialogTitle } from '@/components/ui/dialog';
    import { Avatar, AvatarFallback } from '@/components/ui/avatar';
    const ui = <DialogContent><DialogTitle>Title</DialogTitle><SelectGroup><SelectItem value="a">A</SelectItem></SelectGroup><Avatar><AvatarFallback>A</AvatarFallback></Avatar></DialogContent>`
  assert.deepEqual(rules(source), [])
})

test('business code cannot bypass typography presets', () => {
  has('<Button className="text-[13px]" />', 'typography/preset-only')
  has('<Button style={{ fontSize: 13 }} />', 'typography/no-inline-values')
  has('<Button className="[font-size:13px]" />', 'typography/preset-only')
  has('<Button className="hover:!text-[13px]" />', 'typography/preset-only')
})

test('system colors are not mistaken for arbitrary font sizes', () => {
  const diagnostics = rules('<div className="text-[CanvasText] text-[color:var(--color)]" />')
  assert.ok(!diagnostics.includes('typography/preset-only'))
  assert.ok(diagnostics.includes('style/semantic-colors'))
})

test('arbitrary lengths are typography, not colors', () => {
  const diagnostics = rules('<div className="text-[13px]" />')
  assert.ok(diagnostics.includes('typography/preset-only'))
  assert.ok(!diagnostics.includes('style/semantic-colors'))
})

test('CSS cannot bypass typography restrictions', () => {
  for (const css of ['.x { font-size: 13px }', '.x { @apply text-[13px] }', '@theme { --text-sm: 13px }', '.x { font: 500 13px Arial }']) assert.ok(auditCss('app/a.css', css, policy).some(d => d.rule.startsWith('typography/')))
  assert.ok(auditCss('app/a.css', '.custom { background: red }', policy).some(d => d.rule === 'style/no-custom-css'))
})

test('framework html/body shell is not mistaken for a handmade widget', () => {
  assert.deepEqual(auditSource('app/layout.tsx', '<html lang="zh-CN"><body>{children}</body></html>', policy), [])
  assert.ok(auditSource('app/layout.tsx', '<html><body><button /></body></html>', policy).some(d => d.rule === 'components/no-handwritten-ui'))
})

test('plain layout containers stay legal: only elements with a component equivalent are banned', () => {
  const source = `${prefix}
    const ui = <div className="flex flex-col gap-2"><span className="text-xs">a</span><p className="text-sm">b</p><section><header /><footer /></section></div>`
  assert.deepEqual(rules(source), [])
})

test('a component callsite may adjust appearance, but raw palettes stay banned', () => {
  assert.deepEqual(rules(`${prefix}\nconst ui = <Button className="rounded-full text-sm text-muted-foreground" />`), [])
  has('<Button className="text-emerald-600" />', 'style/semantic-colors')
})

test('a render prop host element is composition, not a hand-written control', () => {
  const source = `import { SidebarMenuSubButton } from '@/components/ui/sidebar';
    const ui = <SidebarMenuSubButton render={<button type="button" />} onClick={go}>x</SidebarMenuSubButton>`
  assert.deepEqual(rules(source), [])
  has('<button>Save</button>', 'components/no-handwritten-ui')
})

test('official buttonVariants links are permitted without bypassing class checks', () => {
  const source = `import { buttonVariants as linkStyle } from '@/components/ui/button';`
  assert.deepEqual(rules(`${source} const ui = <a href="/" className={linkStyle({ variant: 'ghost', className: 'justify-start' })}>返回</a>`), [])
  has(`${source} const ui = <a className={linkStyle({ className: getClasses() })} />`, 'style/static-layout-only')
  has(`${source} const ui = <a className={linkStyle({ className: 'text-[13px]' })} />`, 'typography/preset-only')
  has(`${source} const ui = <a className={linkStyle({ ...untrusted })} />`, 'style/static-layout-only')
  has(`import { buttonVariants } from './custom'; const ui = <a className={buttonVariants()} />`, 'style/static-layout-only')
})

test('only the configured component-library directories are outside the business UI audit', () => {
  for (const file of ['components/ui/button.tsx', 'components/reui/frame.tsx', 'components/blocks/rich-text-editor-2/page.tsx']) assert.ok(isComponentLibrarySource(file, policy))
  for (const file of ['components/auth-form.tsx', 'components/workspace/issue-editor.tsx', 'components/ui-custom.tsx', 'app/page.tsx']) assert.ok(!isComponentLibrarySource(file, policy))
})

test('lint permits imported components but fails handwritten business UI without any source lock', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'orvilo-ui-policy-'))
  const filename = 'components/example.tsx'
  const original = 'import { Button } from "@/components/ui/button"; export const Example = () => <Button variant="outline">Save</Button>'
  const execute = async () => {
    let result
    try {
      result = { ...await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./lint-ui.mjs', import.meta.url)), '--json'], { cwd, encoding: 'utf8', timeout: 15000 }), status: 0 }
    } catch (error) {
      assert.equal(typeof error.code, 'number')
      assert.ok(!error.killed, 'Lint subprocess must finish before its timeout')
      result = { ...error, status: error.code }
    }
    return { status: result.status, report: JSON.parse(result.stdout) }
  }
  try {
    execFileSync('git', ['init', '--quiet'], { cwd })
    for (const library of policy.componentRoots) {
      mkdirSync(path.join(cwd, library), { recursive: true })
      writeFileSync(path.join(cwd, library, 'example.tsx'), 'export const LibraryComponent = () => <button className="text-[13px]">Save</button>')
    }
    writeFileSync(path.join(cwd, 'ui-policy.json'), JSON.stringify(policy))
    writeFileSync(path.join(cwd, 'components.json'), JSON.stringify({ style: policy.style, iconLibrary: policy.iconLibrary.replace('-react', '') }))
    writeFileSync(path.join(cwd, filename), original)
    const composed = await execute()
    assert.equal(composed.status, 0)
    assert.equal(composed.report.errors, 0)
    assert.equal(composed.report.libraryFiles, policy.componentRoots.length)
    assert.equal(composed.report.files, 1)
    writeFileSync(path.join(cwd, filename), 'export const Example = () => <button>Save</button>')
    const handwritten = await execute()
    assert.equal(handwritten.status, 1)
    assert.ok(handwritten.report.diagnostics.some(d => d.rule === 'components/no-handwritten-ui'))
    assert.ok(handwritten.report.diagnostics.every(d => d.file === filename))
    writeFileSync(path.join(cwd, filename), original.replace('variant="outline"', 'style={{ fontSize: 13 }}'))
    const styled = await execute()
    assert.equal(styled.status, 1)
    assert.ok(styled.report.diagnostics.some(d => d.rule === 'style/no-inline-ui'))
    assert.ok(styled.report.diagnostics.some(d => d.rule === 'typography/no-inline-values'))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('utility parser respects bracket expressions and variants', () => {
  assert.deepEqual(splitUtilities('flex [&_svg]:size-4 text-[length:var(--size)]'), ['flex', '[&_svg]:size-4', 'text-[length:var(--size)]'])
  assert.equal(utilityBase('dark:hover:text-[length:var(--size)]'), 'text-[length:var(--size)]')
})

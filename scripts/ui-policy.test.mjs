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
  ['list item bottom rule with last reset', '<div className="border-b last:border-0" />', 'style/divider-list-item'],
  ['list item top rule with first reset', '<div className="border-t first:border-t-0" />', 'style/divider-list-item'],
  ['mapped list item bottom rule', 'const ui = items.map(item => <div key={item} className="border-b py-2" />)', 'style/divider-list-item'],
  ['mapped list item via return', 'const ui = items.map(item => { return (<div key={item} className="border-y" />) })', 'style/divider-list-item'],
  ['divide custom color', '<div className="divide-y divide-muted" />', 'style/divider-default'],
  ['divide explicit default token', '<div className="divide-y divide-border" />', 'style/divider-default'],
  ['divide custom width', '<div className="divide-y-2" />', 'style/divider-default'],
  ['divide arbitrary color', '<div className="divide-y divide-[#eee]" />', 'style/divider-default'],
  ['divide dashed', '<div className="divide-y divide-dashed" />', 'style/divider-default'],
  ['separator custom color', 'import { Separator } from "@/components/ui/separator"; import { Card, CardHeader, CardContent } from "@/components/ui/card"; const ui = <div><span /><Separator className="bg-border/50" /><span /></div>', 'style/divider-default'],
  ['separator custom thickness', 'import { Separator } from "@/components/ui/separator"; import { Card, CardHeader, CardContent } from "@/components/ui/card"; const ui = <div><span /><Separator className="h-0.5" /><span /></div>', 'style/divider-default'],
  ['hand-drawn horizontal rule', '<div className="h-px w-full bg-border" />', 'style/divider-element'],
  ['hand-drawn vertical rule', '<div className="h-4 w-px bg-border" />', 'style/divider-element'],
  ['divide between cards', 'import { Separator } from "@/components/ui/separator"; import { Card, CardHeader, CardContent } from "@/components/ui/card"; const ui = <div className="divide-y"><Card><CardHeader /><CardContent /></Card></div>', 'style/divider-between-bordered'],
  ['divide between bordered mapped items', 'const ui = <div className="divide-y">{items.map(i => <div key={i} className="rounded-lg border p-3" />)}</div>', 'style/divider-between-bordered'],
  ['divide between filled items', '<div className="divide-y"><div className="bg-muted" /></div>', 'style/divider-between-bordered'],
  ['separator next to card', 'import { Separator } from "@/components/ui/separator"; import { Card, CardHeader, CardContent } from "@/components/ui/card"; const ui = <div><span /><Separator /><Card><CardHeader /><CardContent /></Card></div>', 'style/divider-between-bordered'],
  ['separator as first item', 'import { Separator } from "@/components/ui/separator"; import { Card, CardHeader, CardContent } from "@/components/ui/card"; const ui = <div><Separator /><span /></div>', 'style/divider-edge'],
  ['separator as last item', 'import { Separator } from "@/components/ui/separator"; import { Card, CardHeader, CardContent } from "@/components/ui/card"; const ui = <div><span /><Separator /></div>', 'style/divider-edge'],
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

test('shared settings fields retain form grouping checks without accepting lookalike wrappers', () => {
  const imports = `import { SettingsGroup as Group, SettingsRow as Row } from '@/components/ui/settings-layout'; import { Input } from '@/components/ui/input';`
  assert.deepEqual(rules(`${imports} const ui = <form><Group><Row title="Name" htmlFor="name"><Input id="name" /></Row></Group></form>`), [])
  has(`${imports} const ui = <form><Row title="Name"><Input /></Row></form>`, 'forms/field-group')
  has(`import { SettingsGroup, SettingsRow } from './custom'; import { Input } from '@/components/ui/input'; const ui = <form><SettingsGroup><SettingsRow><Input /></SettingsRow></SettingsGroup></form>`, 'forms/field')
})

test('valid grouped items + title + avatar', () => {
  const source = `import { SelectGroup, SelectItem } from '@/components/ui/select';
    import { DialogContent, DialogTitle } from '@/components/ui/dialog';
    import { Avatar, AvatarFallback } from '@/components/ui/avatar';
    const ui = <DialogContent><DialogTitle>Title</DialogTitle><SelectGroup><SelectItem value="a">A</SelectItem></SelectGroup><Avatar><AvatarFallback>A</AvatarFallback></Avatar></DialogContent>`
  assert.deepEqual(rules(source), [])
})

test('spec-approved dividers stay legal', () => {
  const source = `${prefix}
    import { Separator } from '@/components/ui/separator';
    const orientation = 'vertical';
    const ui = <div className="flex flex-col gap-6 rounded-lg border p-4">
      <header className="sticky top-0 border-b px-4">title</header>
      <div className="divide-y">{rows.map(row => <div key={row.id} className="flex h-10 items-center px-3">{row.name}</div>)}</div>
      <div className="flex items-center gap-2"><span /><Separator orientation="vertical" /><span /><Separator orientation={orientation} className="data-vertical:h-4" /><span /></div>
      <section>a</section>
      <Separator />
      <section>b</section>
      <div className="border-l border-t-0 border-t-transparent divide-y-0 divide-x" />
      <div className="h-px w-8 bg-transparent" />
      <footer className="border-t p-3">footer</footer>
    </div>`
  assert.deepEqual(rules(source), [])
})

const dividerRules = source => auditSource('components/example.tsx', `${prefix}\n${source}`, policy).filter(d => d.rule.startsWith('style/divider')).map(d => d.rule)
const flags = (source, rule) => assert.ok(dividerRules(source).includes(rule), `expected ${rule}: ${source}`)
const clean = source => assert.deepEqual(dividerRules(source), [], source)

test('QA #78: list-item borders through class helpers', () => {
  flags('const ui = <div className={cn("border-b", "last:border-0")} />', 'style/divider-list-item')
  flags('const ui = <div className={cn("py-2", active && "border-b last:border-b-0")} />', 'style/divider-list-item')
  flags('const ui = items.map(i => <div key={i} className={cn("flex", "border-b")} />)', 'style/divider-list-item')
  flags('import clsx from "clsx"; const ui = <div className={clsx("border-t", "first:border-t-0")} />', 'style/divider-list-item')
  flags('import { clsx } from "clsx"; const ui = items.map(i => <div key={i} className={clsx("border-b")} />)', 'style/divider-list-item')
  flags('import { twMerge } from "tailwind-merge"; const ui = <div className={twMerge("border-b", "last:border-0")} />', 'style/divider-list-item')
  flags('const row = "border-b py-2"; const ui = items.map(i => <div key={i} className={row} />)', 'style/divider-list-item')
  assert.ok(rules('import { cva } from "class-variance-authority"; const row = cva("border-b last:border-0")').includes('components/no-custom-implementation'), 'cva stays banned outright')
  clean('const ui = <header className={cn("sticky top-0", "border-b")} />')
  clean('const ui = <div className={cn("border-b-0", "last:border-0")} />')
  clean('const ui = <div className={cn("divide-y")}>{items.map(i => <div key={i} className={cn("py-2")} />)}</div>')
})

test('QA #78: list items returned via Fragment and Array.from', () => {
  flags('import { Fragment } from "react"; const ui = items.map(i => <Fragment key={i}><div className="border-b py-2" /></Fragment>)', 'style/divider-list-item')
  flags('const ui = items.map(i => <><div className="border-b" /></>)', 'style/divider-list-item')
  flags('const ui = items.map(i => (<React.Fragment key={i}><dt className="border-t" /><dd /></React.Fragment>))', 'style/divider-list-item')
  flags('const ui = Array.from(items, i => <div key={i} className="border-b" />)', 'style/divider-list-item')
  flags('const ui = Array.from({ length: 3 }, (_, i) => { return <div key={i} className="border-y" /> })', 'style/divider-list-item')
  flags('const ui = <div className="divide-y">{items.map(i => <><div key={i} className="rounded border" /></>)}</div>', 'style/divider-between-bordered')
  flags('const ui = <div className="divide-y">{Array.from(items, i => <div key={i} className="bg-muted" />)}</div>', 'style/divider-between-bordered')
  clean('const ui = Array.from(items, i => <div key={i} className="py-2" />)')
  clean('const ui = Array.from(items)')
  clean('const ui = items.forEach(i => <div className="border-b" />)')
  clean('const ui = <><header className="border-b" /><main /></>')
  clean('const ui = items.map(i => <Fragment key={i}><div className="py-2" /></Fragment>)')
})

test('QA #78: sticky group headers inside map are layout boundaries', () => {
  clean('const ui = groups.map(g => <div key={g} className="sticky top-0 border-b bg-background px-3 py-1" />)')
  clean('const ui = groups.map(g => <Fragment key={g}><div className="sticky top-0 border-b" /><Rows /></Fragment>)')
  clean('const ui = groups.map(g => <div key={g} className={cn("sticky top-0", "border-b")} />)')
  flags('const ui = groups.map(g => <div key={g} className="relative border-b" />)', 'style/divider-list-item')
})

test('QA #78: exemption comments are real comments for the next element only', () => {
  clean(`const ui = items.map(item => (
      // ui-policy-allow divider: sticky table header row needs its own rule
      <div key={item} className="border-b last:border-0" />
    ))`)
  clean(`const ui = <div>
      {/* ui-policy-allow divider: legacy audit table keeps row rules */}
      <div
        key="a"
        data-x="1"
        className="border-b last:border-0"
      />
    </div>`)
  clean(`const ui = items.map(item => (
      /* ui-policy-allow divider: printed report rows need row rules */
      <div key={item} className="border-b" />
    ))`)
  // reason too short (< 10 characters)
  flags(`const ui = items.map(item => (
      // ui-policy-allow divider: legacy
      <div key={item} className="border-b last:border-0" />
    ))`, 'style/divider-list-item')
  flags(`const ui = items.map(item => (
      // ui-policy-allow divider:
      <div key={item} className="border-b last:border-0" />
    ))`, 'style/divider-list-item')
  // a string literal with the same text is not a comment
  flags(`const note = "ui-policy-allow divider: this is only a string literal"
    const ui = items.map(item => <div key={item} className="border-b" />)`, 'style/divider-list-item')
  flags(`const ui = <div><span title="ui-policy-allow divider: this is only an attribute" />
      <div className="border-b last:border-0" /></div>`, 'style/divider-list-item')
  // the comment covers only the immediately following element
  const both = dividerRules(`const ui = <div>
      {/* ui-policy-allow divider: only the first row is exempt here */}
      <div className="border-b last:border-0" />
      <div className="border-b last:border-0" />
    </div>`)
  assert.deepEqual(both, ['style/divider-list-item'])
  // a comment far above (not leading the element) does not apply
  flags(`// ui-policy-allow divider: file-level comment should not apply
    const x = 1
    const ui = <div className="border-b last:border-0" />`, 'style/divider-list-item')
})

test('QA #78: exemptions are reported with location and reason', () => {
  const result = auditSource('components/example.tsx', `${prefix}
    const ui = <div>
      {/* ui-policy-allow divider: legacy audit table keeps row rules */}
      <div className="border-b last:border-0" />
    </div>`, policy)
  assert.equal(result.filter(d => d.rule.startsWith('style/divider')).length, 0)
  assert.equal(result.exemptions.length, 1)
  assert.equal(result.exemptions[0].line, 3) // the comment's own line
  assert.deepEqual(result.exemptions[0].rules, ['style/divider-list-item'])
  assert.equal(result.exemptions[0].reason, 'legacy audit table keeps row rules')
})

test('unread divider file stays exempt', () => {
  const unread = `import { Separator } from '@/components/ui/separator'; const ui = <div><Separator className="bg-primary" /></div>`
  assert.deepEqual(auditSource('components/chat/unread-divider.tsx', unread, policy).filter(d => d.rule.startsWith('style/divider')), [])
})

test('business code cannot bypass typography presets', () => {
  has('<Button className="text-[13px]" />', 'typography/preset-only')
  has('<Button style={{ fontSize: 13 }} />', 'typography/no-inline-values')
  has('<Button className="[font-size:13px]" />', 'typography/preset-only')
  has('<Button className="hover:!text-[13px]" />', 'typography/preset-only')
})

test('field titles retain the shared primary hierarchy', () => {
  const imports = `import { FieldLabel, FieldTitle, FieldContent, FieldDescription } from '@/components/ui/field';`
  has(`${imports} const ui = <FieldLabel className="text-muted-foreground">Name</FieldLabel>`, 'forms/label-hierarchy')
  has(`${imports} const ui = <FieldTitle className="font-normal">Name</FieldTitle>`, 'forms/label-hierarchy')
  has(`${imports} const ui = <FieldContent><span className="text-sm text-muted-foreground">Name</span><FieldLabel className="sr-only" htmlFor="name">Name</FieldLabel></FieldContent>`, 'forms/visible-label')
  assert.deepEqual(rules(`${imports} const ui = <FieldContent><FieldLabel htmlFor="name">Name</FieldLabel><FieldDescription>Help</FieldDescription></FieldContent>`), [])
  assert.deepEqual(rules(`${imports} const ui = <FieldContent><FieldLabel className="sr-only" htmlFor="query">Search</FieldLabel></FieldContent>`), [])
})

test('browser CSS assertions are not typography utilities, while test JSX remains checked', () => {
  assert.deepEqual(auditSource('tests/e2e/settings.spec.ts', `await expect(label).toHaveCSS('font-weight', '500')`, policy), [])
  assert.ok(auditSource('tests/e2e/settings.spec.ts', '<Button className="text-[13px]" />', policy).some(d => d.rule === 'typography/preset-only'))
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
  assert.deepEqual(auditSource('app/[locale]/layout.tsx', '<html lang={locale}><body>{children}</body></html>', policy), [])
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
  const cwd = mkdtempSync(path.join(tmpdir(), 'mikka-ui-policy-'))
  const filename = 'components/example.tsx'
  const original = 'import { Button } from "@/components/ui/button"; export const Example = ({ onSave }) => <Button variant="outline" onClick={onSave}>Save</Button>'
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
      writeFileSync(path.join(cwd, library, 'example.tsx'), !['components/ui/', 'components/reui/'].includes(library) ? 'import { Button } from "@/components/ui/button"; export const LibraryComponent = ({ onSave }) => <Button onClick={onSave}>Save</Button>' : 'export const LibraryComponent = ({ onSave }) => <button className="text-[13px]" onClick={onSave}>Save</button>')
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
    writeFileSync(path.join(cwd, filename), original)
    writeFileSync(path.join(cwd, 'components/blocks/example.tsx'), 'export const Example = () => <Button onClick={() => {}}>Save</Button>')
    const deadBlock = await execute()
    assert.equal(deadBlock.status, 1)
    assert.ok(deadBlock.report.diagnostics.some(d => d.file === 'components/blocks/example.tsx' && d.rule === 'interaction/no-placeholder-action'))
    assert.ok(deadBlock.report.interactionFiles > 0)
    writeFileSync(path.join(cwd, 'components/blocks/example.tsx'), 'export const Example = ({ onSave }) => <button onClick={onSave}>Save</button>')
    const rawBlock = await execute()
    assert.equal(rawBlock.status, 1)
    assert.ok(rawBlock.report.diagnostics.some(d => d.file === 'components/blocks/example.tsx' && d.rule === 'interaction/use-button-component'))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('utility parser respects bracket expressions and variants', () => {
  assert.deepEqual(splitUtilities('flex [&_svg]:size-4 text-[length:var(--size)]'), ['flex', '[&_svg]:size-4', 'text-[length:var(--size)]'])
  assert.equal(utilityBase('dark:hover:text-[length:var(--size)]'), 'text-[length:var(--size)]')
})

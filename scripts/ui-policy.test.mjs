import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
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
  ['horizontal bottom rule', '<div className="border-b" />', 'style/no-horizontal-rule'],
  ['horizontal top rule', '<div className="lg:border-t-2" />', 'style/no-horizontal-rule'],
  ['horizontal both rule', '<div className="border-y" />', 'style/no-horizontal-rule'],
  ['row divider rule', '<div className="divide-y" />', 'style/no-horizontal-rule'],
  ['hand-drawn rule', '<div className="h-px w-full bg-border" />', 'style/no-horizontal-rule'],
  ['horizontal separator', 'import { Separator } from "@/components/ui/separator"; const ui = <Separator />', 'style/no-horizontal-rule'],
  ['dynamic separator orientation', 'import { Separator } from "@/components/ui/separator"; const ui = <Separator orientation={vertical ? "vertical" : "horizontal"} />', 'style/no-horizontal-rule'],
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
  ['transition all', '<Button className="transition-all" />', 'motion/transition-all'],
  ['uppercase tracked label', '<Button className="uppercase tracking-wider" />', 'typography/uppercase-label'],
  ['sparkle icon', 'import { Sparkles } from "lucide-react";', 'icons/no-sparkle'],
]) test(label, () => has(`${prefix}\n${source}`, rule))

test('local fonts must be registered with their CSS variable', () => {
  const approved = `import localFont from 'next/font/local';
    const fontSans = localFont({ src: '../fonts/InterVariable.woff2', variable: '--font-inter', weight: '100 900' });`
  assert.deepEqual(auditSource('app/[locale]/layout.tsx', approved, policy), [])
  for (const source of [approved.replace('InterVariable.woff2', 'Other-Variable.woff2'), approved.replace('--font-inter', '--font-other')]) {
    assert.ok(auditSource('app/[locale]/layout.tsx', source, policy).some(d => d.rule === 'typography/font-family'))
  }
  const pair = `import localFont from 'next/font/local';
    const fontSans = localFont({ src: [{ path: '../fonts/InterVariable.woff2', style: 'normal' }, { path: '../fonts/InterVariable-Italic.woff2', style: 'italic' }], variable: '--font-inter' });`
  assert.deepEqual(auditSource('app/[locale]/layout.tsx', pair, policy), [])
  assert.ok(auditSource('app/[locale]/layout.tsx', pair.replace('InterVariable-Italic.woff2', 'Other-Italic.woff2'), policy).some(d => d.rule === 'typography/font-family'))
})

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

test('icon-only buttons need no data-icon, text buttons still do', () => {
  assert.deepEqual(rules(`import { X } from "lucide-react"; const ui = <Button size="icon-sm" aria-label="x"><X /></Button>`), [])
  assert.ok(rules(`import { X } from "lucide-react"; const ui = <Button size="sm"><X />Close</Button>`).includes('icons/data-icon'))
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

test('vertical separators, box borders and spacing-based grouping stay legal', () => {
  const source = `${prefix}
    import { Separator } from '@/components/ui/separator';
    const orientation = 'vertical';
    const ui = <div className="flex flex-col gap-6 rounded-lg border p-4">
      <Separator orientation="vertical" />
      <Separator orientation={'vertical'} />
      <Separator orientation={\`vertical\`} />
      <Separator orientation={orientation} />
      <div className="border-l border-t-0 border-t-transparent divide-y-0 divide-x" />
      <div className="h-px w-8 bg-transparent" />
    </div>`
  assert.deepEqual(rules(source), [])
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
  // R-32's document body token passes only at its pinned value.
  assert.deepEqual(auditCss('app/a.css', '@theme inline { --text-md: 0.9375rem; --text-md--line-height: 1.5rem }', policy), [])
  assert.ok(auditCss('app/a.css', '@theme inline { --text-md: 16px }', policy).some(d => d.rule === 'typography/no-css-values'))
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
    console.error(`Retained UI policy fixture directory: ${cwd}`)
  }
})

test('R-31: a Button may not bring back a white fill with a border', () => {
  has(`${prefix} const ui = <Button variant="outline" className="border-border bg-background" />`, 'style/secondary-button-fill')
  has(`${prefix} const ui = <Button className={cn('border bg-card')} />`, 'style/secondary-button-fill')
  has(`${prefix} const ui = <Button variant="outline" className="rounded-full bg-background" />`, 'style/secondary-button-fill')
  has(`${prefix} const ui = <Button variant="secondary" className="bg-background hover:bg-background/80" />`, 'style/secondary-button-fill')
  const clean = source => assert.ok(!rules(`${prefix} const ui = ${source}`).includes('style/secondary-button-fill'), source)
  clean('<Button variant="outline" className="rounded-full" />')
  clean('<Button variant="ghost" className="border-transparent hover:bg-background" />')
  clean('<Button className="border-0 bg-background" />')
  clean('<Button className="focus-visible:border-input bg-card" />')
  clean('<Button className="hover:border bg-card" />')
})

test('a segmented control track comes from ToggleGroup variant="segment", not call-site classes', () => {
  has(`${prefix} const ui = <ToggleGroup className="rounded-lg bg-muted p-0.5" />`, 'style/segment-track')
  has(`${prefix} const ui = <ToggleGroup className={cn('h-7')} />`, 'style/segment-track')
  const clean = source => assert.ok(!rules(`${prefix} const ui = ${source}`).includes('style/segment-track'), source)
  clean('<ToggleGroup variant="segment" size="sm" spacing={0.5} />')
  clean('<ToggleGroup className="ml-auto flex-wrap" />')
  clean('<ToggleGroup className="grid grid-cols-6 gap-y-3 px-6" />')
  clean('<ToggleGroupItem className="h-7" />')
})

test('R-33: a dialog keeps the primitive radius', () => {
  has(`${prefix} const ui = <DialogContent className="gap-4 rounded-2xl p-0" />`, 'style/dialog-radius')
  has(`${prefix} const ui = <AlertDialogContent className={cn('rounded-lg')} />`, 'style/dialog-radius')
  const clean = source => assert.ok(!rules(`${prefix} const ui = ${source}`).includes('style/dialog-radius'), source)
  clean('<DialogContent className="gap-4 p-0" />')
  clean('<DialogContent className="h-dvh w-screen rounded-none" />')
})

test('utility parser respects bracket expressions and variants', () => {
  assert.deepEqual(splitUtilities('flex [&_svg]:size-4 text-[length:var(--size)]'), ['flex', '[&_svg]:size-4', 'text-[length:var(--size)]'])
  assert.equal(utilityBase('dark:hover:text-[length:var(--size)]'), 'text-[length:var(--size)]')
})

test('MIK-8: only UnreadDivider and the right column\'s GroupHeader may draw a horizontal Separator', () => {
  const source = 'import { Separator } from "@/components/ui/separator"; const ui = <Separator />'
  const rules = file => auditSource(file, source, policy).map(item => item.rule)
  assert.ok(!rules('components/chat/unread-divider.tsx').includes('style/no-horizontal-rule'))
  assert.ok(!rules('components/nav/group-header.tsx').includes('style/no-horizontal-rule'))
  assert.ok(rules('components/chat/unread-pill.tsx').includes('style/no-horizontal-rule'))
  assert.ok(rules('components/coordinator/coordinator-chat.tsx').includes('style/no-horizontal-rule'))
  assert.ok(rules('components/settings/members.tsx').includes('style/no-horizontal-rule'))
})

test('the issue page may draw its header and comment-card lines (R-61, R-63); other pages may not', () => {
  for (const file of ['components/workspace/issue-detail-header.tsx', 'components/workspace/issue-activity.tsx', 'components/workspace/issue-thread-panel.tsx']) {
    assert.ok(!auditSource(file, '<header className="border-b border-rule" />', policy).some(d => d.rule === 'style/no-horizontal-rule'))
  }
  assert.ok(auditSource('components/workspace/task-detail.tsx', '<div className="border-b border-rule" />', policy).some(d => d.rule === 'style/no-horizontal-rule'))
})

test('R-31: a search field is the shared SearchInput, never an outlined Input with a magnifier', () => {
  const icons = `import { Search } from 'lucide-react'; import { Input } from '@/components/ui/input'; import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'; import { SidebarInput } from '@/components/ui/sidebar';`
  has(`${icons} const ui = <Input type="search" />`, 'style/search-input')
  has(`${icons} const ui = <Input aria-label={t('searchAria')} />`, 'style/search-input')
  has(`${icons} const ui = <Input placeholder="搜索项目…" />`, 'style/search-input')
  has(`${icons} const ui = <div><Search /><SidebarInput /></div>`, 'style/search-input')
  has(`${icons} const ui = <InputGroup><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput /></InputGroup>`, 'style/search-input')
  const clean = source => assert.ok(!rules(`${icons} import { SearchInput } from '@/components/ui/search-input'; const ui = ${source}`).includes('style/search-input'), source)
  clean(`<SearchInput aria-label={t('searchAria')} placeholder={t('searchPlaceholder')} />`)
  clean(`<Input type="email" aria-label={t('email')} />`)
  clean(`<InputGroup><InputGroupInput type="email" /><InputGroupAddon><Mail /></InputGroupAddon></InputGroup>`)
})

test('one container per surface: a frame inside a frame is a double border', () => {
  const imports = `${prefix} import { Card, CardHeader, CardContent } from '@/components/ui/card'; import { Item } from '@/components/ui/item'; import { FramePanel } from '@/components/reui/frame'; import { SettingsLoading, SettingsSection } from '@/components/settings/primitives'; import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';`
  has(`${imports} const ui = <div className="rounded-xl border"><div className="rounded-lg border p-3" /></div>`, 'style/nested-frame')
  has(`${imports} const ui = <SettingsSection title="x"><SettingsLoading label="x" /></SettingsSection>`, 'style/nested-frame')
  has(`${imports} const ui = <FramePanel><Item variant="outline" /></FramePanel>`, 'style/nested-frame')
  has(`${imports} const ui = <Card><CardHeader /><CardContent><div className={cn('rounded-md border', active && 'border-primary')} /></CardContent></Card>`, 'style/nested-frame')
  const clean = source => assert.ok(!rules(`${imports} const ui = ${source}`).includes('style/nested-frame'), source)
  clean(`<SettingsSection title="x"><SettingsLoading label="x" bare /></SettingsSection>`)
  clean(`<div className="rounded-xl border"><div className="rounded-lg bg-muted p-3" /></div>`)
  clean(`<div className="rounded-xl border"><div className="hover:border rounded-lg" /></div>`)
  clean(`<div className="rounded-lg border"><div className="rounded-full border bg-popover shadow-lg" /></div>`)
  clean(`<Card><CardHeader /><CardContent><Dialog><DialogContent><DialogTitle>x</DialogTitle><div className="rounded-lg border" /></DialogContent></Dialog></CardContent></Card>`)
  clean(`<FramePanel><Item /></FramePanel>`)
})

test('Chinese takes the system font, as in Comma: no self-hosted text font draws CJK and --font-sans names none before the system stack', async () => {
  const { createRequire } = await import('node:module')
  const fontkit = createRequire(import.meta.url)('next/dist/compiled/@next/font/dist/fontkit').default
  const root = new URL('../', import.meta.url)
  const cjk = cp => (cp >= 0x2E80 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFFEF)
  // A Latin font that drew CJK would win over the system font for those characters (mixed punctuation, wrong glyphs).
  for (const file of ['InterVariable.woff2', 'InterVariable-Italic.woff2']) {
    const font = (fontkit.default ?? fontkit)(readFileSync(new URL(`app/fonts/${file}`, root)))
    assert.deepEqual(font.characterSet.filter(cjk).map(cp => `U+${cp.toString(16).toUpperCase()}`), [], file)
  }
  const stack = readFileSync(new URL('app/globals.css', root), 'utf8').match(/--font-sans:\s*([^;]+);/)[1].split(',').map(family => family.trim().replaceAll('"', ''))
  assert.deepEqual(stack, ['var(--font-inter)', 'SF Pro Display', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Open Sans', 'Helvetica Neue', 'sans-serif'])
})

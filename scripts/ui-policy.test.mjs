import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { auditSource, auditCss, registryPreviewSources, sourceHash, splitUtilities, utilityBase } from './ui-policy.mjs'

const policy = JSON.parse(readFileSync(new URL('../ui-policy.json', import.meta.url), 'utf8'))
const prefix = `import { cn } from '@/lib/utils'; import { Button } from '@/components/ui/button';`
const rules = (source, options) => auditSource('components/example.tsx', source, policy, options).map(d => d.rule)
const has = (source, rule, options) => assert.ok(rules(source, options).includes(rule), `${rule}: ${source}`)

for (const [label, source, rule] of [
  ['raw HTML', '<button>Save</button>', 'registry/no-handwritten-ui'],
  ['HTML alias', 'const Tag = "button"; const ui = <Tag />', 'registry/no-handwritten-ui'],
  ['UI directory is not trusted', '<div className="flex" />', 'registry/no-handwritten-ui'],
  ['primitive bypass', 'import { Button } from "@base-ui/react/button"; const ui = <Button />', 'registry/no-primitive-bypass'],
  ['factory alias', 'import { createElement as make } from "react"; make("button")', 'registry/no-element-factory'],
  ['DOM factory', 'document.createElement("button")', 'registry/no-custom-implementation'],
  ['custom variants', 'import { cva } from "class-variance-authority"; cva("bg-muted")', 'registry/no-custom-implementation'],
  ['spread props', '<Button {...props} />', 'registry/no-unchecked-spread'],
  ['inline style', '<Button style={{ color: "red" }} />', 'style/no-inline-ui'],
  ['inline font', '<Button style={{ fontSize: 13 }} />', 'typography/no-inline-values'],
  ['arbitrary font size', '<Button className="text-[13px]" />', 'typography/preset-only'],
  ['variable font size', '<Button className="text-(length:--size)" />', 'typography/preset-only'],
  ['arbitrary line height', '<Button className="leading-[1.2]" />', 'typography/preset-only'],
  ['non preset font weight', '<Button className="font-extrabold" />', 'typography/preset-only'],
  ['non preset size', '<Button className="text-9xl" />', 'typography/preset-only'],
  ['slash line height', '<Button className="text-sm/13" />', 'typography/preset-only'],
  ['caller font override', '<Button className="text-sm" />', 'typography/no-callsite-override'],
  ['caller color override', '<Button className="bg-primary" />', 'style/layout-only'],
  ['caller custom CSS class', '<Button className="my-custom-button" />', 'style/layout-only'],
  ['indirect caller override', 'const classes = "text-sm"; const ui = <Button className={classes} />', 'typography/no-callsite-override'],
  ['cn indirect override', 'const classes = "font-bold"; const ui = <Button className={cn("flex", classes)} />', 'typography/no-callsite-override'],
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

test('verified registry source permits its implementation but NOT non-preset typography', () => {
  assert.deepEqual(rules('<div className="text-sm font-medium" />', { verified: true }), [])
  has('<div className="text-[13px]" />', 'typography/preset-only', { verified: true })
  has('<div style={{ fontSize: 13 }} />', 'typography/no-inline-values', { verified: true })
  has('<div className="[font-size:13px]" />', 'typography/preset-only', { verified: true })
  has('<div className="hover:!text-[13px]" />', 'typography/preset-only', { verified: true })
})

test('system colors are not mistaken for arbitrary font sizes', () => {
  const diagnostics = rules('<div className="text-[CanvasText] text-[color:var(--color)]" />', { verified: true })
  assert.ok(!diagnostics.includes('typography/preset-only'))
  assert.ok(diagnostics.includes('style/semantic-colors'))
})

test('arbitrary lengths are typography, not colors', () => {
  const diagnostics = rules('<div className="text-[13px]" />', { verified: true })
  assert.ok(diagnostics.includes('typography/preset-only'))
  assert.ok(!diagnostics.includes('style/semantic-colors'))
})

test('CSS cannot bypass typography restrictions', () => {
  for (const css of ['.x { font-size: 13px }', '.x { @apply text-[13px] }', '@theme { --text-sm: 13px }', '.x { font: 500 13px Arial }']) assert.ok(auditCss('app/a.css', css, policy).some(d => d.rule.startsWith('typography/')))
  assert.ok(auditCss('app/a.css', '.custom { background: red }', policy).some(d => d.rule === 'style/no-custom-css'))
})

test('framework html/body shell is not mistaken for a handmade widget', () => {
  assert.deepEqual(auditSource('app/layout.tsx', '<html lang="zh-CN"><body>{children}</body></html>', policy), [])
  assert.ok(auditSource('app/layout.tsx', '<html><body><div /></body></html>', policy).some(d => d.rule === 'registry/no-handwritten-ui'))
})

test('source receipts ignore formatting but detect implementation edits', () => {
  assert.equal(sourceHash('const a = "hello";'), sourceHash("const a='hello'"))
  assert.equal(sourceHash('<Card>\n  <Button />\n</Card>'), sourceHash('<Card><Button /></Card>'))
  assert.equal(sourceHash('<Card className="cn-font-heading" />'), sourceHash('<Card className="font-heading" />'))
  assert.equal(sourceHash('import { Button } from "@/registry/base-nova/ui/button"'), sourceHash('import { Button } from "@/components/ui/button"'))
  assert.notEqual(sourceHash('<button />'), sourceHash('<div />'))
  assert.notEqual(sourceHash('<Button className="flex" />'), sourceHash('<Button className="flex text-sm" />'))
  assert.notEqual(sourceHash('const a = "hello";'), sourceHash('const a = "changed";'))
  assert.notEqual(sourceHash('.x { color: red }', 'a.css'), sourceHash('.x { color: blue }', 'a.css'))
})

test('registry preview extracts only CLI generated sources and fails closed', () => {
  const preview = '┌ shadcn add (dry run)\n├ components/ui/button.tsx (skip) 2 lines\n│ │ import React from "react"\n│ │ const ui = <button />\n│ └──\n├ components/ui/card.tsx (overwrite) 1 lines\n│ │ const card = <div />\n└ Run without --dry-run to apply.'
  const files = registryPreviewSources(preview)
  assert.equal(files.get('components/ui/button.tsx'), 'import React from "react"\nconst ui = <button />')
  assert.equal(files.get('components/ui/card.tsx'), 'const card = <div />')
  assert.equal(registryPreviewSources('unexpected CLI output').size, 0)
})

test('utility parser respects bracket expressions and variants', () => {
  assert.deepEqual(splitUtilities('flex [&_svg]:size-4 text-[length:var(--size)]'), ['flex', '[&_svg]:size-4', 'text-[length:var(--size)]'])
  assert.equal(utilityBase('dark:hover:text-[length:var(--size)]'), 'text-[length:var(--size)]')
})

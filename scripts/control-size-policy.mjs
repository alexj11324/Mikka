import ts from 'typescript'

// One height scale for every control (R-99). A row that mixes steps — a 28px
// button beside a 32px select — is the defect these tokens exist to prevent:
// the two controls cannot line up, and wrapping makes their edges wander.
//
// `Button`, `NativeSelect`, `InputGroup`, `Input` and `SearchInput` all take
// their height from --control-xs/sm/md/lg (app/globals.css), so the check here
// is not about pixels: it reads the step each control in one row asks for and
// fails when a row asks for two. A control with no step takes `default`; an
// explicit height class is read as the step it equals.

const STEPS = {
  'control-xs': 'xs',
  'control-sm': 'sm',
  'control-md': 'md',
  'control-lg': 'lg',
  'h-(--control-xs)': 'xs',
  'h-(--control-sm)': 'sm',
  'h-(--control-md)': 'md',
  'h-(--control-lg)': 'lg',
  'size-(--control-xs)': 'xs',
  'size-(--control-sm)': 'sm',
  'size-(--control-md)': 'md',
  'size-(--control-lg)': 'lg',
  'h-6': 'xs',
  'h-7': 'sm',
  'h-8': 'md',
  'h-9': 'lg',
  'size-6': 'xs',
  'size-7': 'sm',
  'size-8': 'md',
  'size-9': 'lg',
}

// A row: the element that lays its children out horizontally along one line.
// `flex-col` stacks, a `grid` lays out by column definition rather than by a
// shared baseline, and `flex-1` rows are usually a text line beside a chip.
const ROW = /^(?:flex|inline-flex)$/
const STACKS = /^(?:flex-(?:col|row-reverse|col-reverse)|grid|grid-cols-\d+)$/

// Controls whose height comes from the shared scale. `ToggleGroupItem` takes
// its step from its parent `ToggleGroup`, so it is not read on its own.
const CONTROLS = new Set(['Button', 'NativeSelect', 'Input', 'InputGroup', 'SearchInput', 'ToggleGroup'])

const EXEMPT = /control-size-exempt:\s*\S/

/** A row keeps an exemption from its own line, the line above, or a comment up to two lines above. */
function isExempt(lines, lineIndex) {
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 2); i--) {
    if (EXEMPT.test(lines[i] ?? '')) return true
  }
  return false
}/** The utility classes an attribute expression names, with variant prefixes stripped. */
function classesOf(expression) {
  const found = []
  const visit = node => {
    if (ts.isStringLiteralLike(node)) {
      found.push(...node.text.split(/\s+/).filter(Boolean).map(name => name.split(':').at(-1)))
    } else if (ts.isTemplateExpression(node)) {
      found.push(...node.head.text.split(/\s+/).filter(Boolean).map(name => name.split(':').at(-1)))
      node.templateSpans.forEach(span => found.push(...span.literal.text.split(/\s+/).filter(Boolean).map(name => name.split(':').at(-1))))
    }
    ts.forEachChild(node, visit)
  }
  visit(expression)
  return found
}

/** The step a control asks for: its `size` prop, then any explicit height class. */
function stepOf(opening, source) {
  for (const prop of opening.attributes.properties) {
    if (!ts.isJsxAttribute(prop)) continue
    const name = prop.name.getText(source)
    if (name === 'size') {
      const init = prop.initializer
      if (!init) return 'md'
      if (ts.isStringLiteralLike(init)) {
        if (init.text === 'xs' || init.text === 'icon-xs' || init.text === 'icon-compact') return 'xs'
        if (init.text === 'sm' || init.text === 'icon-sm') return 'sm'
        if (init.text === 'lg' || init.text === 'icon-lg') return 'lg'
        if (init.text === 'default' || init.text === 'icon') return 'md'
        return null
      }
      return null
    }
    if (name === 'data-size') {
      const init = prop.initializer
      if (init && ts.isStringLiteralLike(init)) return init.text === 'sm' ? 'sm' : 'md'
    }
  }
  // No size prop: an explicit height class sets the step. A control that names
  // both keeps the prop, because the variant's own classes come first and
  // `cn` lets the later utility win.
  const hasSizeProp = opening.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'size')
  if (hasSizeProp) return null
  const className = opening.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'className')
  const value = className?.initializer && (ts.isJsxExpression(className.initializer) ? className.initializer.expression : className.initializer)
  if (value) {
    for (const name of classesOf(value)) {
      if (STEPS[name]) return STEPS[name]
    }
  }
  return 'md'
}

export function auditControlSizes(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX)
  const lines = text.split('\n')
  const diagnostics = []

  const openingOf = node => (ts.isJsxElement(node) ? node.openingElement : node)

  const classNameOf = opening => {
    const attr = opening.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'className')
    const value = attr?.initializer && (ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer)
    return value ? classesOf(value) : []
  }

  const visit = node => {
    const isElement = ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)
    if (isElement) {
      const opening = openingOf(node)
      const names = classNameOf(opening)
      if (names.some(name => ROW.test(name)) && !names.some(name => STACKS.test(name))) {
        // This row's controls: a box that only wraps them (Field, FieldGroup,
        // Popover, a Tooltip trigger) is transparent, while a nested row
        // answers for its own children.
        const controls = []
        const TRANSPARENT = new Set(['Field', 'FieldGroup', 'Popover', 'PopoverTrigger', 'Tooltip', 'TooltipTrigger', 'HoverCard', 'HoverCardTrigger', 'DropdownMenu', 'DropdownMenuTrigger'])
        const collect = child => {
          if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
            const childOpening = openingOf(child)
            const tag = childOpening.tagName.getText(source)
            const childNames = classNameOf(childOpening)
            if (CONTROLS.has(tag)) {
              controls.push({ tag, step: stepOf(childOpening, source), opening: childOpening })
              return
            }
            // A nested row answers for its own children; a stack (flex-col, grid) is
            // not on this row at all, so its controls cannot be misaligned with it.
            if (!TRANSPARENT.has(tag) && childNames.some(name => STACKS.test(name) || ROW.test(name))) return
          }
          ts.forEachChild(child, collect)
        }
        if (ts.isJsxElement(node)) node.children.forEach(collect)
        const steps = [...new Set(controls.map(control => control.step).filter(Boolean))]
        if (steps.length > 1) {
          const { line, character } = source.getLineAndCharacterOfPosition(opening.getStart(source))
          if (!isExempt(lines, line)) diagnostics.push({
            file, line: line + 1, column: character + 1, rule: 'layout/control-size',
            message: `同一行控件取了两个高度档位（${steps.join(' / ')}）：32px 与 28px 并排会错位。让它们共用 --control-xs/sm/md/lg 的同一档；不是工具条的行用 \`control-size-exempt: 原因\` 说明。`,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return diagnostics
}

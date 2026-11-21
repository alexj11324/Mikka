import { readFileSync } from 'node:fs'

/**
 * ALE-17's invariants, checked in source rather than in a browser.
 *
 * These are the facts the fix asserts, stated so a later edit cannot quietly undo them. They are deliberately narrow:
 * they prove the shape of the code, not the look of the page. Layout parity is the screenshot harness
 * (tests/e2e/visual-issue-detail.spec.ts); this file never substitutes for it.
 */

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/**
 * The class strings a JSX element carries: `className="..."`, `className={cn('...', '...')}` and the render-prop
 * `render={<Button className="..." />}` form. Comments are stripped first, so prose that names a utility (this
 * repository explains its selectors in comments) is never mistaken for the utility itself.
 */
export function classStrings(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const strings = []
  for (const match of withoutComments.matchAll(/className=\{?("([^"]*)"|'([^']*)'|`([^`]*)`|\{cn\(([\s\S]*?)\)\})/g)) {
    const literal = match[2] ?? match[3] ?? match[4]
    if (literal !== undefined) { strings.push(literal); continue }
    // cn( ... ): every quoted argument in the call.
    for (const inner of (match[5] ?? '').matchAll(/["'`]([^"'`]*)["'`]/g)) strings.push(inner[1])
  }
  return strings
}

function tokens(source) {
  return classStrings(source).flatMap(value => value.split(/\s+/)).filter(Boolean)
}

/** Container-query steps used against one named container, e.g. `@md/header:hidden` -> 'md'. Excludes the `@container/header` declaration itself. */
export function containerSteps(source, container) {
  const steps = new Set()
  for (const token of tokens(source)) {
    if (token === `@container/${container}`) continue
    // The token carries its own variant suffix (`@md/header:hidden`), hence no anchor after the container name.
    const match = new RegExp(`(?:^|:)@([a-z0-9]+)/${container}(?=:|$)`).exec(token)
    if (match) steps.add(match[1])
  }
  return [...steps].sort()
}

/** Viewport breakpoint prefixes a file's class strings use (sm:, md:, lg:, xl:, 2xl:). */
export function viewportSteps(source) {
  const steps = new Set()
  for (const token of tokens(source)) {
    // Only a leading viewport variant counts, with any number of state variants before it.
    const match = /^(?:[a-z-]+:)*(sm|md|lg|xl|2xl):/.exec(token)
    if (match) steps.add(match[1])
  }
  return [...steps].sort()
}

/** Literal descendant-button min-height selectors that force a height, which also take in nested buttons. */
export function descendantButtonMinHeight(source) {
  // A `min-h-0` reset only removes a height; the defect is a selector that imposes one.
  return tokens(source).filter(token => /\[&_button\]:min-h-(?!0\b)\d+/.test(token))
}

/** True when `needle` sits outside the element opened by `openTag` (matched to its own closing tag by depth). */
export function needleOutsideElement(source, openTag, needle) {
  const start = source.indexOf(openTag)
  // A file without the disclosure at all cannot have relations outside it.
  if (start < 0) return false
  const bodyStart = source.indexOf('>', start) + 1
  let depth = 1
  let index = bodyStart
  while (index < source.length && depth > 0) {
    const nextOpen = source.indexOf('<div', index)
    const nextClose = source.indexOf('</div>', index)
    if (nextClose < 0) break
    if (nextOpen >= 0 && nextOpen < nextClose) { depth++; index = nextOpen + 4 }
    else { depth--; index = nextClose + 6 }
  }
  return !source.slice(bodyStart, index).includes(needle)
}

export const FILES = {
  properties: 'components/workspace/issue-detail-properties.tsx',
  header: 'components/workspace/issue-detail-header.tsx',
  taskDetail: 'components/workspace/task-detail.tsx',
}

export function auditRepository(readFile = read) {
  const findings = []
  const properties = readFile(FILES.properties)
  const header = readFile(FILES.header)
  const taskDetail = readFile(FILES.taskDetail)

  // ALE-17 item 2: no descendant selector forcing 44px on chips and menu triggers.
  for (const selector of descendantButtonMinHeight(properties)) findings.push({ rule: 'properties/descendant-button-min-height', detail: selector })

  // ALE-17 item 1: the disclosure's own region holds the relations, so the phone collapses the column as one unit.
  if (needleOutsideElement(properties, 'id={contentId}', '{relations}')) findings.push({ rule: 'properties/relations-outside-disclosure' })

  // ALE-17 item 3: one breakpoint system, at most three steps.
  const viewport = viewportSteps(header)
  if (viewport.length) findings.push({ rule: 'header/viewport-breakpoints', detail: viewport.join(',') })
  const steps = containerSteps(header, 'header')
  if (steps.length > 3) findings.push({ rule: 'header/too-many-container-steps', detail: steps.join(',') })

  // ALE-17 item 5: the title states its size through the scale, never with !important.
  if (classStrings(taskDetail).some(value => /\btext-2xl!\s/.test(`${value} `))) findings.push({ rule: 'title/important-font-size' })

  return findings
}

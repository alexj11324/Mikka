// One motion scale (R-103). Before it, business code carried the whole Tailwind
// ladder — 0/100/150/200/250/300/350/400/450/1000 — so two panels that opened
// together did not feel like one product. The tokens live in app/globals.css
// (--motion-fast/base/slow), and a business file names the step, not the
// milliseconds: `duration-(--motion-base)`, never `duration-200`.
//
// The vendored component roots (ui-policy.json `componentRoots`) are exempt:
// they ship as downloaded, so their internals are not ours to retime here. The
// list is read from the policy rather than repeated, so a root added there does
// not silently fall outside this check.

import { readFileSync } from 'node:fs'

const policy = JSON.parse(readFileSync(new URL('../ui-policy.json', import.meta.url), 'utf8'))
const COMPONENT_ROOTS = policy.componentRoots

/** True for a file under one of the vendored component roots. */
export function isComponentRoot(file) {
  return COMPONENT_ROOTS.some(root => file.startsWith(root))
}

const RAW = /\bduration-(?:50|75|100|150|200|250|300|350|400|450|500|700|1000)\b/g
const ARBITRARY = /\bduration-\[[^\]]*\]/g
/** A reason is real words after the marker, not just the comment's own closer. */
const EXEMPT = /motion-exempt:\s*(?!\*\/)\S/
/** `duration-0`, `duration-[0ms]` and `duration-[0s]` are "no transition", not a duration. */
const INSTANT = /^duration-(?:0|\[0(?:ms|s)\])$/

/** `motion-exempt: <reason>` on the line, or on either of the two lines above it. */
function isExempt(lines, index) {
  if (EXEMPT.test(lines[index] ?? '')) return true
  return lines.slice(Math.max(0, index - 2), index).some(line => EXEMPT.test(line))
}

/** A comment or a JSDoc block explains a duration; it does not set one. */
function isComment(line) {
  const text = line.trim()
  return text.startsWith('//') || text.startsWith('/*') || text.startsWith('*') || text.startsWith('{/*')
}

/** A business file's raw durations, each with the token that replaces it. */
export function auditMotion(file, text) {
  if (isComponentRoot(file)) return []
  const lines = text.split('\n')
  const problems = []
  lines.forEach((line, index) => {
    if (isComment(line) || isExempt(lines, index)) return
    for (const match of line.matchAll(RAW)) {
      if (INSTANT.test(match[0])) continue
      const ms = Number(match[0].replace('duration-', ''))
      const token = ms <= 160 ? '--motion-fast' : ms <= 260 ? '--motion-base' : '--motion-slow'
      problems.push({ file, line: index + 1, rule: 'motion/raw-duration', found: match[0],
        message: `裸 duration（${match[0]}）：用 duration-(${token})，让同一屏的动效共用一个节奏（R-103）。` })
    }
    for (const match of line.matchAll(ARBITRARY)) {
      if (INSTANT.test(match[0])) continue
      problems.push({ file, line: index + 1, rule: 'motion/raw-duration', found: match[0],
        message: `任意值时长（${match[0]}）：用 duration-(--motion-fast/base/slow)。` })
    }
  })
  return problems
}

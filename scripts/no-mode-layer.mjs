// Main has never carried a thread "mode" layer: no `task_thread_modes` table, no
// `thread_mode` column, no `ThreadMode` type, no `lib/thread-mode/`, no
// `app/api/threads/[runId]/mode/` route. ALE-3/4/5/7 were once briefed on the
// assumption that #1886 had already landed a three-way mode switch on main. It had
// not: the mode work lived only on that unmerged branch, and main's thread is a
// single `issues` container with `agent_runs` folded into a chain.
//
// Nothing on main is broken by this — but nothing stops the layer from arriving by
// accident either, half-adopted and unbacked by its decision. This guard is the
// tripwire. A thread mode is a product decision first: when it is made, it adds its
// file to `docs/design/decisions/` and registers the new surface here in one commit.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A dated decision log may name the layer it is deciding about; the policy test
// holds the negative examples. Everything else in the tree is checked.
export const allowedPaths = ['docs/design/decisions', 'scripts/no-mode-layer.mjs', 'scripts/no-mode-layer.test.mjs']

/**
 * Case-sensitive and word-bounded on purpose. Case-insensitive or unbounded matching
 * collapses `ThreadMode` into `ThreadModel` (the provider-fallback view), which main
 * carries legitimately in ~23 files, and `thread-mode` into `thread-model` in the
 * `data-thread-model-*` attributes. `/\bthread[-_]modes?\b/` is safe against
 * `thread-model` because no word boundary falls between `mode` and `l`.
 */
export const modeLayerTokens = [
  ['task_thread_modes table', /\btask_thread_modes\b/],
  ['thread_modes table', /\bthread_modes\b/],
  ['thread_mode column', /\bthread_mode\b/],
  ['ThreadMode type', /\bThreadMode\b/],
  ['threadMode binding', /\bthreadMode\b/],
  ['thread-mode module or route', /\bthread[-_]modes?\b|\/threads\/[^\s'"`]*\/mode\b/],
]

const exempt = (file) => allowedPaths.some((path) => file === path || file.startsWith(`${path}/`))

/** Offending lines in one file, in token order; empty for an exempt path. */
export function modeLayerHits(text, file = '') {
  if (exempt(file)) return []
  return text.split('\n').flatMap((line, index) => {
    const token = modeLayerTokens.find(([, pattern]) => pattern.test(line))
    return token ? [{ line: index + 1, name: token[0], text: line.trim() }] : []
  })
}

/** Paths that themselves are the layer, whatever their contents say. */
export const modeLayerPaths = [/^lib\/thread-mode\//, /^app\/api\/threads\/\[runId\]\/mode\//]

export function modeLayerPathHits(file) {
  return exempt(file) ? [] : modeLayerPaths.filter((pattern) => pattern.test(file)).map((pattern) => String(pattern))
}

/**
 * Every tracked file, scanned with git so the answer is about the repository rather
 * than whatever happens to be on disk. Returns `{ findings, scanned }`.
 */
export function auditNoModeLayer(root = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const files = git('ls-files').split('\n').filter(Boolean)
  const findings = []
  for (const file of files) {
    for (const name of modeLayerPathHits(file)) findings.push({ file, line: 0, name, text: file })
    let source
    try { source = readFileSync(join(root, file), 'utf8') } catch { continue }
    for (const hit of modeLayerHits(source, file)) findings.push({ file, ...hit })
  }
  return { findings, scanned: files.length }
}

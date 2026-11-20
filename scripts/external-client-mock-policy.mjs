// #2886: integration tests retain the actual provider client and substitute HTTP.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const baselinePath = 'scripts/external-client-mock-baseline.json'
const clients = new Set(['e2b', '@slack/web-api', '@slack/bolt', '@chat-adapter/slack', '@octokit/rest', '@octokit/core', 'octokit',
  'lib/computer/e2b-provider', 'lib/factory/merge', 'lib/slack/automation-notice', 'lib/slack/install-provider',
  'lib/github/user-access', 'lib/github/cloud', 'lib/github/official-cloud-relay', 'lib/github/pull-directory',
  'lib/github/pull-detail', 'lib/github/pull-merge', 'lib/github/mcp'])

function modulePath(file, value) {
  const path = value.startsWith('@/') ? value.slice(2) : value.startsWith('.') ? posix.normalize(posix.join(dirname(file), value)) : value
  return path.replace(/\.[cm]?[jt]sx?$/, '')
}

function literal(node) {
  if (!node) return null
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'href') return literal(node.expression)
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') return literal(node.arguments?.[0])
  return null
}

export function externalClientMocks(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), found = []
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'module') {
      const value = literal(node.arguments[0]), target = value && modulePath(file, value)
      if (target && clients.has(target)) found.push({ file, module: target, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

export function auditExternalClientMocks(findings, baseline, previous = baseline) {
  const errors = [], counts = new Map()
  for (const item of findings) {
    const key = `${item.file}:${item.module}`, count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    if (count > (baseline[key] ?? 0)) errors.push(`${item.file}:${item.line} provider-module-mock: ${item.module}; use tests/fakes HTTP service`)
  }
  for (const [key, count] of Object.entries(baseline)) {
    if (!Number.isInteger(count) || count < 1 || count > (previous[key] ?? 0)) errors.push(`${baselinePath}: baseline may only shrink (${key})`)
  }
  return errors
}

export function repositoryExternalClientMocks(root = process.cwd()) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0')
  return [...new Set(files)].filter(file => /\.[cm]?[jt]sx?$/.test(file) && !/(?:^|\/)(?:node_modules|\.hosted-ui|\.output)\//.test(file) && existsSync(resolve(root, file)))
    .flatMap(file => externalClientMocks(file, readFileSync(resolve(root, file), 'utf8')))
}

export function runExternalClientMockPolicy(root = process.cwd()) {
  const baseline = JSON.parse(readFileSync(resolve(root, baselinePath), 'utf8'))
  // Compare against the merge base so the same PR cannot enlarge its allowance.
  // On the introducing PR there is no older allowance; later PRs can only remove.
  const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const exists = execFileSync('git', ['ls-tree', '--name-only', base, '--', baselinePath], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const previous = exists ? JSON.parse(execFileSync('git', ['show', `${base}:${baselinePath}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) : baseline
  return auditExternalClientMocks(repositoryExternalClientMocks(root), baseline, previous)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = runExternalClientMockPolicy()
  for (const error of errors) console.error(error)
  process.exitCode = errors.length ? 1 : 0
}

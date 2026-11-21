import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const sha = /^[a-f0-9]{40}$/
const registry = 'scripts/ci/tasks.json'
const requirements = 'config/self-hosted-requirements.json'
const testInput = file => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec|type-test|node-test)\.[^/]+$|_test\.go$/.test(file)
// These files select, configure or execute the test inventory. Their contents
// remain the reviewed main ancestor's; test bodies may change in a backport.
const inventoryInput = file => file.startsWith('scripts/ci/') ||
  /^\.github\/(?:workflows|actions)\//.test(file) ||
  /(?:^|\/)scripts\//.test(file) && !testInput(file) ||
  /^(?:tests\/(?:helpers|support)|packages\/config|patches)\//.test(file) ||
  /(?:^|\/)(?:package\.json|project\.json|nx\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|go\.(?:mod|sum|work|work\.sum)|\.npmrc|\.pnpmfile\.cjs|\.node-version|\.nvmrc|\.gitmodules|\.gitattributes)$/.test(file) ||
  /(?:^|\/)(?:tsconfig(?:\.[^/]*)?|[^/]+\.config|oxlint|\.oxlintrc|\.eslintrc)(?:\.[^/]*)?\.(?:json|[cm]?[jt]s|ya?ml)$/.test(file)

const fail = (code, file, cause) => { throw new Error(code + (file ? ': ' + file : ''), { cause }) }
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

/** Read only a main-ancestry-proven registry for an otherwise unchanged frozen
 * CI installation. This grants full coverage, never a selective skip or code
 * execution from the unmerged target branch. */
export function frozenUnitInventory(root, { policy, base, head, checkout }) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
  const ancestor = (from, to) => spawnSync('git', ['merge-base', '--is-ancestor', from, to], { cwd: root }).status === 0
  if (![policy, base, head].every(value => typeof value === 'string' && sha.test(value)) ||
      policy !== git('rev-parse', 'refs/remotes/origin/main^{commit}')) fail('frozenCiPolicyNotTrusted')
  // Ordinary main-based PRs keep their existing trusted-base behavior.
  if (ancestor(base, policy)) return null
  const actual = git('rev-parse', 'HEAD')
  if (typeof checkout !== 'string' || !sha.test(checkout) || checkout !== actual ||
      !ancestor(base, actual) || !ancestor(head, actual)) fail('frozenCiCandidateIdentityMismatch')
  // Most stacked feature PRs already use main's full registry. They retain
  // the original main-policy path even if other CI files differ from the fork.
  const currentTasks = JSON.parse(git('show', `${policy}:${registry}`))
  const candidateTasks = JSON.parse(git('show', `${actual}:${registry}`))
  if (isDeepStrictEqual(candidateTasks, currentTasks)) return null
  const anchors = git('merge-base', '--all', base, policy).split('\n')
  if (anchors.length !== 1 || !sha.test(anchors[0]) || !ancestor(anchors[0], policy)) fail('frozenCiAnchorNotTrusted')
  const anchor = anchors[0]
  const tree = ref => new Map(git('ls-tree', '-r', '-z', ref).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t')
    const [mode, type, blob] = line.slice(0, tab).split(' ')
    return [line.slice(tab + 1), { mode, type, blob }]
  }))
  const approved = tree(anchor), target = tree(actual), branchBase = tree(base)
  const paths = new Set([...approved.keys(), ...target.keys(), ...branchBase.keys()])
  const protectedPaths = [...paths].filter(file => inventoryInput(file) || testInput(file) || file === requirements)
  if (!approved.has(registry)) fail('frozenCiInventoryChanged', registry)
  for (const file of protectedPaths) {
    const expected = approved.get(file), candidate = target.get(file), prior = branchBase.get(file)
    if (!expected || !candidate || !prior || expected.type !== 'blob' ||
        !['100644', '100755'].includes(expected.mode) || candidate.mode !== expected.mode || prior.mode !== expected.mode ||
        candidate.type !== expected.type || prior.type !== expected.type) fail('frozenCiInventoryChanged', file)
    if (inventoryInput(file) && (candidate.blob !== expected.blob || prior.blob !== expected.blob)) fail('frozenCiInventoryChanged', file)
    try {
      const stat = lstatSync(resolve(root, file))
      if (!stat.isFile() || (stat.mode & 0o111 ? '100755' : '100644') !== candidate.mode ||
          gitBlob(readFileSync(resolve(root, file))) !== candidate.blob) fail('frozenCiInventoryChanged', file)
    } catch (cause) { fail('frozenCiInventoryChanged', file, cause) }
  }
  // An unstaged/staged addition must not evade the committed inventory check.
  for (const file of git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    if ((inventoryInput(file) || testInput(file) || file === requirements) && !target.has(file)) fail('frozenCiInventoryChanged', file)
  }
  if (approved.has(requirements)) {
    let previous = JSON.parse(git('show', `${anchor}:${requirements}`))
    for (const ref of [base, actual]) {
      const extended = JSON.parse(git('show', `${ref}:${requirements}`))
      if (!previous || Array.isArray(previous) || typeof previous !== 'object' || !extended ||
          Array.isArray(extended) || typeof extended !== 'object' ||
          Object.entries(previous).some(([file, declaration]) => !Object.hasOwn(extended, file) || !isDeepStrictEqual(declaration, extended[file]))) {
        fail('frozenCiInventoryChanged', requirements)
      }
      previous = extended
    }
  }
  // No candidate JavaScript is imported; the immutable main blob is pure data.
  const tasks = JSON.parse(git('show', `${anchor}:${registry}`))
  return { tasks, proof: { policySha: policy, anchorSha: anchor, registryBlob: approved.get(registry).blob } }
}

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { join, posix, resolve } from 'node:path'

export const migrationEntrypoint = 'scripts/migrate.mjs'
export const migrationRoots = Object.freeze(['scripts/check-migrations.mjs', migrationEntrypoint, 'scripts/migration-steps.mjs'])
export const migrationToolchain = Object.freeze(['.node-version', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
const digest = /^sha256:[a-f0-9]{64}$/
const safePath = file => typeof file === 'string' && /^[a-zA-Z0-9_.@+/-]+$/.test(file)
  && !file.startsWith('/') && file === posix.normalize(file)
  && !file.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part.startsWith('.env'))

function fileList(files, match, message) {
  assert.ok(Array.isArray(files) && files.length > 0 && files.every(match), message)
  assert.deepEqual(files, [...new Set(files)].sort(), message)
}

export function validateMigrationManifest(migrations) {
  assert.equal(migrations?.version, 2, 'Migration execution identity v2 is required for a release candidate')
  assert.deepEqual(Object.keys(migrations).sort(), ['contextDigest', 'execution', 'files', 'version'])
  assert.match(migrations.contextDigest ?? '', digest)
  fileList(migrations.files, file => /^drizzle\/[a-zA-Z0-9_-]+\.sql$/.test(file), 'Invalid migration SQL file list')
  const execution = migrations.execution
  assert.ok(execution && typeof execution === 'object' && !Array.isArray(execution))
  assert.deepEqual(Object.keys(execution).sort(), ['contextDigest', 'entrypoint', 'files'])
  assert.equal(execution.entrypoint, migrationEntrypoint)
  assert.match(execution.contextDigest ?? '', digest)
  fileList(execution.files, file => safePath(file) && !file.endsWith('.sql'), 'Invalid migration execution file list')
  for (const file of [...migrationRoots, ...migrationToolchain]) assert.ok(execution.files.includes(file), 'Missing migration execution input: ' + file)
  return migrations
}

/** This permits reading an existing receipt, never admitting a new candidate. */
export function validateHistoricalMigrations(migrations) {
  if (migrations?.version === 2) return validateMigrationManifest(migrations)
  assert.deepEqual(Object.keys(migrations ?? {}).sort(), ['contextDigest', 'files'])
  assert.match(migrations.contextDigest ?? '', digest)
  fileList(migrations.files, file => /^drizzle\/[a-zA-Z0-9_-]+\.sql$/.test(file), 'Invalid historical migration SQL file list')
  return migrations
}

async function regularFile(directory, file) {
  assert.ok(safePath(file), 'Invalid migration input path')
  const path = join(directory, file)
  const info = await lstat(path)
  assert.ok(info.isFile(), 'Migration inputs must be regular files: ' + file)
  assert.equal(await realpath(path), path, 'Migration input parent must not be a symbolic link: ' + file)
  const executable = info.mode & 0o111
  assert.ok(executable === 0 || executable === 0o111, 'Migration input executable mode must match Git: ' + file)
  return { bytes: await readFile(path), executable }
}

/** Kept byte-for-byte reproducible from Git blobs by the independent publisher.
 * Node versions come from the checked-in declaration, never this host's version. */
async function hashFiles(directory, files, parameters) {
  const hash = createHash('sha256').update(JSON.stringify(parameters) + '\0')
  for (const file of files) {
    const { bytes, executable } = await regularFile(directory, file)
    hash.update(JSON.stringify([file, 'file', executable, bytes.length]) + '\0')
    hash.update(bytes)
  }
  return 'sha256:' + hash.digest('hex')
}

function trivia(source, start) {
  let index = start
  for (;;) {
    while (/\s/.test(source[index] ?? '') && index < source.length) index++
    if (source.startsWith('//', index)) {
      const end = source.slice(index + 2).search(/[\n\r\u2028\u2029]/)
      index = end < 0 ? source.length : index + 2 + end + 1
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2)
      assert.notEqual(end, -1, 'Unterminated migration import comment')
      index = end + 2
    } else return index
  }
}

/** Scan the original text conservatively, including template interpolations.
 * Text that merely mentions import() may add a dependency or fail closed; it
 * cannot hide a real import. Computed paths and escaped strings need review. */
function dynamicImports(source) {
  assert.ok(!/\b(?:eval|Function|createRequire)\b/.test(source), 'Migration dynamic code loaders are unsupported')
  const specifiers = []
  for (const match of source.matchAll(/\b(import|require)\b/g)) {
    let index = trivia(source, match.index + match[0].length)
    if (match[1] === 'import' && source[index] === '.') {
      assert.match(source.slice(index), /^\.meta\.url\b/, 'Migration import.meta loaders are unsupported')
      continue
    }
    if (source[index] !== '(') continue
    assert.equal(match[1], 'import', 'Migration require() dependencies are unsupported')
    index = trivia(source, index + 1)
    const quote = source[index++]
    assert.ok(quote === "'" || quote === '"', 'Migration dynamic imports must use one literal path')
    const start = index
    while (index < source.length && source[index] !== quote) {
      assert.ok(!/[\\\r\n]/.test(source[index]), 'Migration dynamic import escapes are unsupported')
      index++
    }
    assert.equal(source[index], quote, 'Unterminated migration dynamic import')
    const specifier = source.slice(start, index)
    index = trivia(source, index + 1)
    assert.equal(source[index], ')', 'Migration dynamic imports must use one literal path')
    specifiers.push(specifier)
  }
  return specifiers
}

// SourceTextModule parses declarations and re-exports without linking or
// evaluating candidate modules. Dynamic import() is handled separately above.
const parseModule = `import {SourceTextModule} from 'node:vm';
import {readFileSync} from 'node:fs';
const module=new SourceTextModule(readFileSync(0,'utf8'));
process.stdout.write(JSON.stringify({nodeMajor:Number(process.versions.node.split('.')[0]),requests:module.moduleRequests}));`

function imports(source) {
  let parsed
  try {
    parsed = JSON.parse(execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', parseModule],
      { input: source, encoding: 'utf8', env: {}, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }))
  } catch (cause) { throw new Error('Migration execution module cannot be parsed without evaluation', { cause }) }
  const { requests, nodeMajor } = parsed
  assert.ok(Array.isArray(requests), 'Migration parser must report import metadata')
  for (const request of requests) {
    assert.ok(typeof request.specifier === 'string' && request.specifier.length > 0)
    // Node 22.20+ reports attributes but predates the source-phase grammar and
    // phase property. Keep its real parser gate; never fall back to the older
    // dependencySpecifiers API, which loses import attributes.
    if (request.phase === undefined) {
      assert.equal(nodeMajor, 22, 'Migration parser must report the import phase')
      for (const match of source.matchAll(/\bimport\b/g)) {
        const index = trivia(source, match.index + match[0].length)
        assert.ok(!/^(?:source|defer)\b/.test(source.slice(index)), 'Migration source-phase imports are unsupported')
      }
    } else assert.equal(request.phase, 'evaluation', 'Migration source-phase imports are unsupported')
    assert.deepEqual(request.attributes, {}, 'Migration import attributes are unsupported')
  }
  return [...new Set([...requests.map(request => request.specifier), ...dynamicImports(source)])]
}

function dependency(specifier, importer, tracked) {
  assert.ok(!['module', 'node:module', 'vm', 'node:vm'].includes(specifier), 'Migration dynamic module loaders are unsupported')
  if (isBuiltin(specifier) || specifier === 'pg') return null
  assert.ok(/^(?:\.\.?\/)[a-zA-Z0-9_./-]+\.m?js$/.test(specifier), 'Unsupported migration dependency: ' + specifier)
  const file = posix.normalize(posix.join(posix.dirname(importer), specifier))
  assert.ok(safePath(file) && tracked.has(file), 'Untracked or escaping migration dependency: ' + file)
  return file
}

function toolchainInput(file) {
  return migrationToolchain.includes(file) || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file)
    || file.startsWith('patches/') || /(?:^|\/)(?:\.npmrc|\.?pnpmfile\.(?:cjs|mjs|js))$/.test(file)
}

const packageHook = file => /(?:^|\/)\.?pnpmfile\.(?:cjs|mjs|js)$/.test(file)

/** Discover the exact existing runner/checker closure using only public source
 * bytes. An unavailable helper, computed import or symlink stops planning. */
export async function buildMigrationExecution({ directory, files }) {
  directory = await realpath(resolve(directory))
  const tracked = new Set(files)
  for (const file of [...migrationRoots, ...migrationToolchain]) assert.ok(tracked.has(file), 'Missing migration execution input: ' + file)
  const pending = [...migrationRoots, ...files.filter(packageHook)]
  const visited = new Set()
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index]
    if (visited.has(file)) continue
    visited.add(file)
    const { bytes } = await regularFile(directory, file)
    for (const specifier of imports(bytes.toString('utf8'))) {
      const imported = dependency(specifier, file, tracked)
      if (imported) pending.push(imported)
    }
  }
  const executionFiles = [...new Set([...visited, ...files.filter(toolchainInput)])].sort()
  const entrypoint = migrationEntrypoint
  return { entrypoint, files: executionFiles,
    contextDigest: await hashFiles(directory, executionFiles, { version: 2, kind: 'migration-execution', entrypoint }) }
}

export async function buildMigrationContext({ directory, files, sqlFiles }) {
  directory = await realpath(resolve(directory))
  assert.deepEqual(sqlFiles, files.filter(file => /^drizzle\/[^/]+\.sql$/.test(file)).sort(), 'Migration SQL identity must include the complete source snapshot')
  const execution = await buildMigrationExecution({ directory, files })
  return validateMigrationManifest({ version: 2, files: sqlFiles, execution,
    contextDigest: await hashFiles(directory, sqlFiles, { version: 2, kind: 'migrations', execution: execution.contextDigest }) })
}

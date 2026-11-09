import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = dirname(fileURLToPath(import.meta.url)), require = createRequire(`${root}/checkout/package.json`)
const ts = require('typescript'), sha = value => createHash('sha256').update(value).digest('hex')
const paths = ['lib/desktop-rpc/read-batch.ts', 'lib/desktop-rpc/read-batch-context.ts', 'lib/desktop-rpc/read-batch-contract.ts', 'lib/live/revision-read.ts']
const files = []
for (const path of paths) {
  const snapshot = `${root}/design-prototype/${path}`
  await mkdir(dirname(snapshot), { recursive: true })
  try { await copyFile(`${root}/prototype/${path}`, snapshot, 1) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const source = await readFile(`${root}/checkout/${path}`, 'utf8')
  await writeFile(`${root}/prototype/${path}`, source)
  const code = ts.transpileModule(source, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace(/^import ['"]server-only['"];?\s*$/mg, '')
    .replace(/(from\s*['"]|import\s*\(\s*['"])(\.{1,2}\/[^'"]+)(['"])/g, (all, pre, specifier, end) => `${pre}${specifier.replace(/\.ts$/, '').replace(/(?<!\.mjs)$/, '.mjs')}${end}`)
  await writeFile(`${root}/prototype/${path.replace(/\.ts$/, '.mjs')}`, code)
  files.push({ path, sha256: sha(source), generatedJsSha256: sha(code) })
}
for (const variant of ['baseline', 'prototype']) await copyFile(`${root}/fixture-template.mjs`, `${root}/${variant}/fixture.mjs`)
const body = async path => {
  const source = await readFile(path, 'utf8'), tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  return tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'readBatchRevisions').getText(tree)
}
const before = await body(`${root}/baseline/lib/desktop-rpc/read-batch-context.ts`)
const after = await body(`${root}/checkout/lib/desktop-rpc/read-batch-context.ts`)
if (before !== after) throw new Error('existing SQL queue/memo body changed')
await writeFile(`${root}/final-copy-probe-source.safe.json`, JSON.stringify({ kind: 'final-actual-source-in-controlled-reader-copy', files,
  originalReadBatchRevisionsFunctionUnchanged: true, originalReadBatchRevisionsFunctionSha256: sha(before), scope: 'Only the SQL/backend and nonmetadata dependencies are fixtures. All four final metadata modules are exact checkout source before TS erasure.' }, null, 2) + '\n')
console.log(JSON.stringify({ finalModules: files.length, queueBodyUnchanged: true }))

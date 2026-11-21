import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { build } from 'vite'
import ts from 'typescript'
import { frontendConfig } from '../vite.config.mjs'
import { deploymentPlugin, pinChunkReferences, pinnedUrl } from './deployment-plugin.mjs'

test('deployment pinning preserves relative resource paths, existing queries and hashes without pinning external URLs', () => {
  assert.equal(pinnedUrl('../chunk.js?mode=a#part', 'release-1'), '../chunk.js?mode=a&dpl=release-1#part')
  assert.equal(pinnedUrl('/mikka/a.css?dpl=old', 'new'), '/mikka/a.css?dpl=new')
  assert.equal(pinnedUrl('https://external.example/a.js', 'release-1'), 'https://external.example/a.js')
  assert.equal(pinnedUrl('//external.example/a.js', 'release-1'), '//external.example/a.js')
})

test('actual emitted static imports, lazy chunks, preload entries and CSS fonts receive the same deployment pin', () => {
  const files = new Set(['assets/main.js', 'assets/shared.js', 'assets/lazy.js', 'assets/font.woff2'])
  const code = 'import value from "./shared.js"; export const read = () => import(`./lazy.js`); const preload = [`assets/shared.js`]; const other = "business-value";'
  const pinned = pinChunkReferences(code, 'assets/main.js', files, 'release-1')
  assert.match(pinned, /\.\/shared\.js\?dpl=release-1/)
  assert.match(pinned, /\.\/lazy\.js\?dpl=release-1/)
  assert.match(pinned, /assets\/shared\.js\?dpl=release-1/)
  assert.match(pinned, /"business-value"/)
  const bundle = { 'assets/font.woff2': { type: 'asset', fileName: 'assets/font.woff2', source: '' }, 'assets/main.css': { type: 'asset', fileName: 'assets/main.css', source: '@font-face{src:url(./font.woff2)}' } }
  deploymentPlugin({ deploymentId: 'release-1' }).generateBundle({}, bundle)
  assert.match(bundle['assets/main.css'].source, /font\.woff2\?dpl=release-1/)
  const html = deploymentPlugin({ deploymentId: 'release-1' }).transformIndexHtml.handler('<script type="module" src="/mikka/assets/main.js"></script><link href="/mikka/brand/mikka-app-icon-48.png">')
  assert.match(html, /main\.js\?dpl=release-1/)
  assert.match(html, /mikka-app-icon-48\.png\?dpl=release-1/)
})

test('the real Vite HTML, lazy module and font outputs keep one deployment identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-deployment-build-'))
  const previous = process.env.MIKKA_DEPLOYMENT_ID
  try {
    process.env.MIKKA_DEPLOYMENT_ID = 'release-contract'
    await Promise.all([
      writeFile(join(directory, 'index.html'), '<html><head><link rel="icon" href="/mikka/brand/mikka-app-icon-48.png"></head><body><script type="module" src="./entry.ts"></script></body></html>'),
      writeFile(join(directory, 'entry.ts'), 'import "./style.css"; import { marker } from "./shared.ts"; window.marker = marker(); window.loadFixture = () => import("./lazy.ts");'),
      writeFile(join(directory, 'lazy.ts'), 'import { marker } from "./shared.ts"; export const loaded = marker()'),
      writeFile(join(directory, 'shared.ts'), 'export const marker = () => Math.random()'),
      writeFile(join(directory, 'style.css'), '@font-face{font-family:Fixture;src:url(./fixture.woff2)}body{font-family:Fixture}'),
      writeFile(join(directory, 'fixture.woff2'), 'local-font-contract'),
    ])
    const outDir = join(directory, 'dist')
    await mkdir(join(outDir, 'assets'), { recursive: true })
    await writeFile(join(outDir, 'assets/stale.js'), 'import "./old-deployment.js";')
    const config = await frontendConfig({ target: 'web' })
    const result = await build({ ...config, root: directory, publicDir: false, logLevel: 'silent', build: { ...config.build, outDir, assetsInlineLimit: 0 } })
    assert.equal((await readdir(join(outDir, 'assets'))).includes('stale.js'), false)
    const html = result.output.find(file => file.fileName === 'index.html').source
    const css = result.output.find(file => file.type === 'asset' && file.fileName.endsWith('.css')).source
    const lazy = result.output.find(file => file.type === 'chunk' && file.isDynamicEntry)
    const entry = result.output.find(file => file.type === 'chunk' && file.isEntry)
    assert.ok(lazy)
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://app.example'))
    assert.ok(urls.length >= 3)
    assert.ok(urls.every(url => url.pathname.startsWith('/mikka/') && url.searchParams.get('dpl') === 'release-contract'))
    assert.ok(entry.code.includes(`${lazy.fileName.split('/').at(-1)}?dpl=release-contract`))
    assert.match(String(css), /fixture[^"()]*\.woff2\?dpl=release-contract/)
    let staticImports = 0
    for (const chunk of result.output.filter(file => file.type === 'chunk')) {
      const source = ts.createSourceFile(chunk.fileName, chunk.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const inspect = node => {
        const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
        if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) staticImports++
          assert.equal(new URL(specifier.text, 'https://app.example/mikka/assets/entry.js').searchParams.get('dpl'), 'release-contract', `${chunk.fileName}: ${specifier.text}`)
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    }
    assert.ok(staticImports > 0, 'fixture must exercise actual shared static imports')
  } finally {
    if (previous === undefined) delete process.env.MIKKA_DEPLOYMENT_ID
    else process.env.MIKKA_DEPLOYMENT_ID = previous
    await rm(directory, { recursive: true, force: true })
  }
})

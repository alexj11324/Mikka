import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MikkaMarkSmall } from '../components/brand/mikka-mark'

// The Mikka mark below 16px (docs/design/brand.md): separate or ghost dots that small broke into a stray glyph
// in source chips and 「安全保护 Mikka」.
test('the small mark is the 13 solid dots, touching, with no ghosts', () => {
  const svg = renderToStaticMarkup(<MikkaMarkSmall />)
  const radii = [...svg.matchAll(/<circle[^>]* r="([\d.]+)"/g)].map(match => Number(match[1]))
  assert.equal(radii.length, 13)
  assert.ok(radii.every(r => r === 6), 'radius is half the 12 pitch, so the dots join into one M')
  assert.doesNotMatch(svg, /opacity/)
})

test('product UI draws small marks with MikkaMarkSmall, never the full mark scaled down', () => {
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) { if (name !== 'ui' && name !== 'node_modules') walk(path); continue }
      if (/\.tsx?$/.test(name) && /components\/ui\/svgs\/mikka['"]/.test(readFileSync(path, 'utf8'))) offenders.push(path)
    }
  }
  for (const root of ['components', 'app']) walk(root)
  assert.deepEqual(offenders, [])
})

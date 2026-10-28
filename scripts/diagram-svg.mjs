// Drawing primitives shared by the README diagrams (generate-diagrams.mjs):
// square boxes, diamonds, blue flow tags, orthogonal lines and open chevrons.
// Solid shapes are shipped; dashed ones are on the roadmap.
import fs from 'node:fs'
import path from 'node:path'

export const FONT = '-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Helvetica, Arial, &quot;PingFang SC&quot;, &quot;Noto Sans CJK SC&quot;, &quot;Microsoft YaHei&quot;, sans-serif'

export const PALETTES = {
  light: { ink: '#111111', box: '#ffffff', blue: '#1a5cff', tag: '#ffffff', muted: '#59636e' },
  dark: { ink: '#e6edf3', box: '#0d1117', blue: '#4d82ff', tag: '#ffffff', muted: '#9198a1' },
}

export const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// Rough rendered width at 14px: CJK glyphs are square, Latin glyphs about half as wide.
export const textWidth = s => [...s].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 14 : 7.6), 0)

function centeredText(cx, cy, lines, p) {
  const first = cy - ((lines.length - 1) * 19) / 2 + 5
  return lines.map((line, i) => `<text x="${cx}" y="${first + i * 19}" text-anchor="middle" font-size="15" fill="${p.ink}">${esc(line)}</text>`)
}

export function rectBox(x0, x1, yc, h, lines, p, planned = false) {
  const dash = planned ? ' stroke-dasharray="7 5"' : ''
  return [
    `<rect x="${x0}" y="${yc - h / 2}" width="${x1 - x0}" height="${h}" fill="${p.box}" stroke="${p.ink}" stroke-width="2.5"${dash}/>`,
    ...centeredText((x0 + x1) / 2, yc, lines, p),
  ]
}

export function diamond(cx, cy, half, lines, p, planned = false) {
  const dash = planned ? ' stroke-dasharray="7 5"' : ''
  const points = `${cx},${cy - half} ${cx + half},${cy} ${cx},${cy + half} ${cx - half},${cy}`
  return [
    `<polygon points="${points}" fill="${p.box}" stroke="${p.ink}" stroke-width="2.5" stroke-linejoin="miter"${dash}/>`,
    ...centeredText(cx, cy, lines, p),
  ]
}

export function tag(cx, cy, label, p, planned = false) {
  const w = Math.round(textWidth(label) + 18)
  if (planned) {
    return [
      `<rect x="${cx - w / 2}" y="${cy - 13}" width="${w}" height="26" fill="${p.box}" stroke="${p.blue}" stroke-width="1.5" stroke-dasharray="4 3"/>`,
      `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" fill="${p.blue}">${esc(label)}</text>`,
    ]
  }
  return [
    `<rect x="${cx - w / 2}" y="${cy - 13}" width="${w}" height="26" fill="${p.blue}"/>`,
    `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" fill="${p.tag}">${esc(label)}</text>`,
  ]
}

export function line(points, p, planned = false) {
  const dash = planned ? ' stroke-dasharray="7 5"' : ''
  const d = 'M' + points.map(([x, y]) => `${x} ${y}`).join(' L')
  return [`<path d="${d}" fill="none" stroke="${p.ink}" stroke-width="2.5"${dash}/>`]
}

export function chevron(x, y, direction, p) {
  const s = 8
  const points = {
    right: [[x - s, y - s], [x, y], [x - s, y + s]],
    left: [[x + s, y - s], [x, y], [x + s, y + s]],
    down: [[x - s, y - s], [x, y], [x + s, y - s]],
    up: [[x - s, y + s], [x, y], [x + s, y + s]],
  }[direction]
  const d = 'M' + points.map(([a, b]) => `${a} ${b}`).join(' L')
  return [`<path d="${d}" fill="none" stroke="${p.ink}" stroke-width="2.5" stroke-linecap="square" stroke-linejoin="miter"/>`]
}

/** The shipped/planned key along the bottom edge. `t` carries the four legend labels. */
export function legend(y, t, p) {
  const flowX = Math.round(352 + textWidth(t.lFlow) + 36)
  return [
    ...rectBox(20, 120, y, 36, [t.lShipped], p, false),
    ...rectBox(140, 240, y, 36, [t.lPlanned], p, true),
    ...line([[280, y], [340, y]], p), ...chevron(318, y, 'right', p),
    `<text x="352" y="${y + 5}" font-size="14" fill="${p.muted}">${esc(t.lFlow)}</text>`,
    ...line([[flowX, y], [flowX + 60, y]], p, true), ...chevron(flowX + 38, y, 'right', p),
    `<text x="${flowX + 72}" y="${y + 5}" font-size="14" fill="${p.muted}">${esc(t.lPlannedFlow)}</text>`,
  ]
}

export const LEGEND_TEXT = {
  en: { lShipped: 'Shipped', lPlanned: 'Planned', lFlow: 'Data flow', lPlannedFlow: 'Planned flow' },
  zh: { lShipped: '已上线', lPlanned: '规划中', lFlow: '数据流', lPlannedFlow: '规划中的数据流' },
}

export function svg(width, height, title, elements) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" role="img" aria-label="${esc(title)}">
  <title>${esc(title)}</title>
  ${elements.join('\n  ')}
</svg>
`
}

/** Writes `<name>-light.svg`, `<name>-dark.svg` and the `-zh` pair to docs/assets. */
export function writeDiagram(root, name, draw) {
  const outDir = path.join(root, 'docs', 'assets')
  fs.mkdirSync(outDir, { recursive: true })
  for (const lang of ['en', 'zh']) {
    for (const theme of Object.keys(PALETTES)) {
      const file = path.join(outDir, `${name}${lang === 'en' ? '' : '-zh'}-${theme}.svg`)
      fs.writeFileSync(file, draw(lang, PALETTES[theme]))
      console.log(path.relative(root, file))
    }
  }
}

// R-104's quiet text level has to be legible where it actually sits. The token
// was once picked against the page alone and came out at 4.498:1 in dark, then
// failed outright at 3.97:1 on a `bg-muted/80` chip — a hand-computed value is
// not a check, so the numbers are computed here from the tokens themselves.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')

/** The declarations of one top-level block (`:root` or `.dark`), as a name → value map. */
function block(selector) {
  const start = css.indexOf(`\n${selector} {`)
  assert.ok(start > 0, `${selector} block not found`)
  const end = css.indexOf('\n}', start)
  const declarations = css.slice(start, end)
  return Object.fromEntries([...declarations.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]))
}

const linear = channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
const srgb = channel => channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055

/** A colour token as { y: linear luminance, channels: sRGB 0…1 triple }. */
function colour(value) {
  const oklch = value.match(/^oklch\(\s*([\d.]+)\s+0\s+0\s*\)$/)
  if (oklch) {
    // An achromatic oklch colour has Y = L³; its channels are that grey encoded.
    const y = Number(oklch[1]) ** 3
    return { y, channels: [srgb(y), srgb(y), srgb(y)] }
  }
  const rgb = value.match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\)$/)
  if (rgb) {
    const channels = rgb.slice(1).map(channel => Number(channel) / 255)
    const [r, g, b] = channels.map(linear)
    return { y: 0.2126 * r + 0.7152 * g + 0.0722 * b, channels }
  }
  assert.fail(`unparsed colour: ${value}`)
}

/** `fg` composited over `bg` at `alpha`, as a linear luminance. */
function over(fg, alpha, bg) {
  return fg.channels.reduce((sum, channel, index) => {
    const composed = alpha * channel + (1 - alpha) * bg.channels[index]
    return sum + [0.2126, 0.7152, 0.0722][index] * linear(composed)
  }, 0)
}

const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

for (const selector of [':root', '.dark']) {
  test(`text-tertiary clears 4.5:1 on the page, a card and a muted fill (${selector})`, () => {
    const tokens = block(selector)
    const tertiary = colour(tokens.tertiary)
    const page = colour(tokens.background)
    const card = colour(tokens.card)
    const muted = colour(tokens.muted)
    // `bg-muted` whole, and `bg-muted/80` as the activity rows write it: the fill at 80% over what is behind.
    const surfaces = {
      page: page.y,
      card: card.y,
      'muted fill': muted.y,
      'muted/80 on page': over(muted, 0.8, page),
      'muted/80 on card': over(muted, 0.8, card),
    }
    for (const [name, background] of Object.entries(surfaces)) {
      const measured = ratio(tertiary.y, background)
      // Three decimals: at two, a failing 4.498 reads as "4.50 needs 4.5".
      assert.ok(measured >= 4.5, `${selector} --tertiary on ${name} is ${measured.toFixed(3)}:1, needs 4.5:1`)
    }
  })

  test(`text-tertiary stays a step quieter than text-muted-foreground (${selector})`, () => {
    const tokens = block(selector)
    assert.ok(ratio(colour(tokens['muted-foreground']).y, colour(tokens.tertiary).y) >= 1.15,
      `${selector}: --tertiary is not visibly quieter than --muted-foreground`)
  })
}

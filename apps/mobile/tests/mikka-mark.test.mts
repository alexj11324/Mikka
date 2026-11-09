import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mock, test } from 'node:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('react-native-svg', {
  namedExports: {
    Svg: ({ accessible, ...props }: { accessible?: boolean; children?: ReactNode }) => createElement('svg', { ...props, 'aria-hidden': !accessible }),
    Circle: 'circle',
    G: 'g',
  },
})
mock.module(new URL('../lib/theme.ts', import.meta.url).href, { namedExports: { colors: { text: 'currentColor' } } })
const { MikkaMark } = await import('../components/MikkaMark.tsx')
const canonical = readFileSync(new URL('../../../app/icon.svg', import.meta.url), 'utf8')

function circles(svg: string) {
  return [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(([, cx, cy, radius]) => [Number(cx), Number(cy), Number(radius)])
}

test('the native sign-in mark matches the official cropped M and ghost dots', () => {
  const svg = renderToStaticMarkup(createElement(MikkaMark))
  const ghost = svg.match(/<g opacity="0.1">(.*?)<\/g>/)?.[1] ?? ''
  const canonicalGhost = canonical.match(/<g class="off">(.*?)<\/g>/)?.[1] ?? ''
  assert.deepEqual(circles(svg), circles(canonical))
  assert.equal(circles(svg).length, 25)
  assert.deepEqual(circles(ghost), circles(canonicalGhost))
  assert.equal(circles(ghost).length, 12)
  assert.match(svg, /width="56" height="56" viewBox="19.2 19.2 61.6 61.6" fill="currentColor"/)
})

test('native sign-in identifies Mikka with the brand mark', () => {
  const signIn = readFileSync(new URL('../components/SignIn.tsx', import.meta.url), 'utf8')
  assert.match(signIn, /<MikkaMark \/>/)
  assert.doesNotMatch(signIn, /BotAvatar/)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequestScope } from './context'

const localeFor = (headers: Record<string, string> = {}) =>
  createRequestScope(new Request('https://app.example.test/mikka', { headers })).locale

test('a browser that asks for English gets English before anyone chooses', () => {
  assert.equal(localeFor({ 'accept-language': 'en-US,en;q=0.9' }), 'en')
  assert.equal(localeFor({ 'accept-language': 'en' }), 'en')
  assert.equal(localeFor({ 'accept-language': 'en-GB,en;q=0.9,zh-CN;q=0.7' }), 'en')
})

test('a browser that asks for Chinese first still gets Chinese', () => {
  assert.equal(localeFor({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }), 'zh-CN')
  assert.equal(localeFor({ 'accept-language': 'zh-CN' }), 'zh-CN')
  assert.equal(localeFor({ 'accept-language': 'zh,en;q=0.9' }), 'zh-CN')
})

test('an explicit choice outranks the browser in both directions', () => {
  assert.equal(localeFor({ 'accept-language': 'en-US,en;q=0.9', cookie: 'NEXT_LOCALE=zh-CN' }), 'zh-CN')
  assert.equal(localeFor({ 'accept-language': 'zh-CN', cookie: 'NEXT_LOCALE=en' }), 'en')
  assert.equal(localeFor({ 'accept-language': 'zh-CN', 'x-mikka-locale': 'en' }), 'en')
  assert.equal(localeFor({ 'accept-language': 'en-US', 'x-mikka-locale': 'zh-CN' }), 'zh-CN')
})

test('a browser that names neither language keeps the previous fallback', () => {
  assert.equal(localeFor({ 'accept-language': 'ja-JP,ja;q=0.9' }), 'zh-CN')
  assert.equal(localeFor({ 'accept-language': '*' }), 'zh-CN')
  assert.equal(localeFor(), 'zh-CN')
})

test('a stored value that is neither locale does not pin the visitor', () => {
  assert.equal(localeFor({ 'accept-language': 'en-US,en;q=0.9', cookie: 'NEXT_LOCALE=fr' }), 'en')
  assert.equal(localeFor({ 'accept-language': 'zh-CN', cookie: 'NEXT_LOCALE=fr' }), 'zh-CN')
})

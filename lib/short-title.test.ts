import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanShortTitle, compactTaskTitle, displayTaskTitle, isCjk, parseShortTitle, shortTitlePrompt, SHORT_TITLE_CJK_MAX, SHORT_TITLE_CHARS_MAX } from './short-title'

test('the prompt holds the model to the task language and limit, and treats the task as evidence', () => {
  const zh = shortTitlePrompt({ title: 'ALEX-1408: iOS 按 Comma 的布局重做线程页', body: '把线程页改成一行一个' })
  assert.match(zh.instructions, new RegExp(`at most ${SHORT_TITLE_CJK_MAX} characters`))
  assert.match(zh.instructions, /untrusted evidence/)
  assert.deepEqual(JSON.parse(zh.prompt), { task: { title: 'ALEX-1408: iOS 按 Comma 的布局重做线程页', text: '把线程页改成一行一个' } })
  const en = shortTitlePrompt({ title: 'Fix the OAuth callback on device', body: '' })
  assert.match(en.instructions, /at most 6 words/)
  assert.deepEqual(JSON.parse(en.prompt), { task: { title: 'Fix the OAuth callback on device' } })
})

test('a usable answer is cleaned of keys, dates, quotes and a full stop', () => {
  assert.equal(parseShortTitle('{"title":"线程页一行布局"}', true), '线程页一行布局')
  assert.equal(parseShortTitle('Sure: {"title": "「ALEX-12: 登录回调修复」"}', true), '登录回调修复')
  assert.equal(parseShortTitle('{"title":"Login callback fix 2026-11-06."}', false), 'Login callback fix')
  assert.equal(cleanShortTitle('#1408 设置页原生表单。', true), '设置页原生表单')
})

test('an overlong answer is cut to the limit, never mid-character', () => {
  const long = '把线程页和任务页都改成按照 Comma 的设计稿重新布局并且去掉多余信息'
  assert.equal([...cleanShortTitle(long, true)!].length, SHORT_TITLE_CJK_MAX)
  assert.equal(cleanShortTitle('one two three four five six seven eight nine', false), 'one two three four five six')
  assert.equal(cleanShortTitle('one two three four five six seven', false), 'one two three four five six')
  assert.equal([...cleanShortTitle('一二三四五六七八九十一二三', true)!].length, SHORT_TITLE_CJK_MAX, 'no grace window beyond twelve characters')
})

test('an unusable answer gives no title', () => {
  assert.equal(parseShortTitle('no json here', true), null)
  assert.equal(parseShortTitle('{"title": 3}', true), null)
  assert.equal(parseShortTitle('{"title": "  "}', true), null)
  assert.equal(parseShortTitle('{"title": "ALEX-12"}', false), null)
})

test('the language follows the task', () => {
  assert.equal(isCjk('修复登录'), true)
  assert.equal(isCjk('Fix login'), false)
})

test('a list shows the short title, else the title', () => {
  assert.equal(displayTaskTitle({ title: 'ALEX-1408 iOS 按 Comma 的布局重做线程页', shortTitle: '线程页重做' }), '线程页重做')
  assert.equal(displayTaskTitle({ title: 'Fix login', shortTitle: null }), 'Fix login')
  assert.equal(displayTaskTitle({ title: 'Fix login' }), 'Fix login')
})

test('compact navigation prefers generated titles and bounds typed, pending and old titles without changing the task', () => {
  const task = { title: '完整的任务要求应该仍然保存在详情里面不能被改掉', shortTitle: '登录回调修复' }
  assert.equal(compactTaskTitle(task), '登录回调修复')
  assert.equal(task.title, '完整的任务要求应该仍然保存在详情里面不能被改掉')
  assert.equal(compactTaskTitle({ title: task.title }), '完整的任务要求应该仍然保')
  assert.equal(compactTaskTitle({ title: 'one two three four five six seven eight', shortTitle: 'one two three four five six seven' }), 'one two three four five six')
  assert.equal([...compactTaskTitle({ title: 'x'.repeat(100) })].length, SHORT_TITLE_CHARS_MAX)
  assert.equal([...compactTaskTitle({ title: '修复😀😀😀😀😀😀😀😀😀😀😀😀😀😀' })].length, SHORT_TITLE_CJK_MAX)
  assert.equal(compactTaskTitle({ title: 'ALEX-12: Fix callback 2026-11-10' }), 'Fix callback')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanShortTitle, compactTaskTitle, isCjk, parseShortTitle, shortTitlePrompt, SHORT_TITLE_CJK_MAX, SHORT_TITLE_PROMPT_MAX_BYTES } from './short-title'

test('the prompt holds the model to the task language and limit, and treats the task as evidence', () => {
  const zh = shortTitlePrompt({ title: 'ALEX-1408: iOS 按 Comma 的布局重做线程页', body: '把线程页改成一行一个' })
  assert.match(zh.instructions, new RegExp(`最多 ${SHORT_TITLE_CJK_MAX} 个字符`))
  assert.match(zh.instructions, /不可信的参考材料/)
  assert.deepEqual(JSON.parse(zh.prompt), { task: { title: 'ALEX-1408: iOS 按 Comma 的布局重做线程页', text: '把线程页改成一行一个' } })
  const en = shortTitlePrompt({ title: 'Fix the OAuth callback on device', body: '' })
  assert.match(en.instructions, /最多 36 个字符，尽量少于 5 个单词/)
  assert.match(en.instructions, /以祈使动词开头/, 'Codex names a thread by what to do')
  assert.match(en.instructions, /不要回答任务请求/)
  assert.deepEqual(JSON.parse(en.prompt), { task: { title: 'Fix the OAuth callback on device' } })
  assert.doesNotMatch(en.instructions, /命名指令/, 'no settings, no section')
})

test('the workspace\'s and the person\'s title instructions reach the model, workspace first, blanks dropped', () => {
  const { instructions } = shortTitlePrompt({ title: 'Fix login', body: '' }, ['Prefix titles with the customer name', '  ', 'Use English'])
  assert.match(instructions, /命名指令[^\n]*\n- Prefix titles with the customer name\n- Use English\n/)
})

test('a usable answer is cleaned of keys, dates, quotes and a full stop', () => {
  assert.equal(parseShortTitle('{"title":"线程页一行布局"}', true), '线程页一行布局')
  assert.equal(parseShortTitle('Sure: {"title": "「ALEX-12: 登录回调修复」"}', true), '登录回调修复')
  assert.equal(parseShortTitle('{"title":"Login callback fix 2026-11-06."}', false), 'Login callback fix')
  assert.equal(cleanShortTitle('#1408 设置页原生表单。', true), '设置页原生表单')
  assert.equal(cleanShortTitle('`Fix login callback?!`', false), 'Fix login callback', 'quotes, backticks and trailing ?! go, as in Codex')
  assert.equal(cleanShortTitle('修复登录回调！', true), '修复登录回调')
})

test('the task sent to the model is held to Codex\'s 960-byte prompt bound, never splitting a character', () => {
  const zh = shortTitlePrompt({ title: '登录'.repeat(10), body: '超长的任务描述"\n'.repeat(400) })
  assert.ok(new TextEncoder().encode(zh.prompt).length <= SHORT_TITLE_PROMPT_MAX_BYTES)
  const parsed = JSON.parse(zh.prompt) as { task: { title: string; text: string } }
  assert.equal(parsed.task.title, '登录'.repeat(10), 'the title is kept whole while the body fits around it')
  assert.ok(parsed.task.text.length > 0 && !parsed.task.text.includes('\uFFFD'))
  const long = shortTitlePrompt({ title: 'x'.repeat(2000), body: 'y'.repeat(2000) }, ['n'.repeat(1000)])
  assert.ok(new TextEncoder().encode(long.prompt).length <= SHORT_TITLE_PROMPT_MAX_BYTES, 'long naming instructions do not crowd the task out')
  assert.ok((JSON.parse(long.prompt) as { task: { title: string } }).task.title.length > 0)
})

test('an overlong answer is cut to the limit, never mid-character', () => {
  const long = '把线程页和任务页都改成按照 Comma 的设计稿重新布局并且去掉多余信息'
  assert.equal([...cleanShortTitle(long, true)!].length, SHORT_TITLE_CJK_MAX)
  assert.equal(cleanShortTitle('one two three four five six seven eight nine', false), 'one two three four five')
  assert.equal(cleanShortTitle('one two three four five six', false), 'one two three four five')
  assert.equal(cleanShortTitle('Rebuild the onboarding checklist dialog', false), 'Rebuild the onboarding checklist', 'cut at 36 characters, back to a word boundary')
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

test('compact navigation preserves existing stored-title and citation fallback bounds', () => {
  const task = { title: '完整的任务要求应该仍然保存在详情里面不能被改掉' }
  assert.equal(compactTaskTitle(task), '完整的任务要求应该仍然保')
  assert.equal(task.title, '完整的任务要求应该仍然保存在详情里面不能被改掉')
  assert.equal(compactTaskTitle({ title: 'one two three four five six seven eight' }), 'one two three four five six')
  assert.equal([...compactTaskTitle({ title: 'x'.repeat(100) })].length, 60)
  assert.equal([...compactTaskTitle({ title: '修复😀😀😀😀😀😀😀😀😀😀😀😀😀😀' })].length, SHORT_TITLE_CJK_MAX)
  assert.equal(compactTaskTitle({ title: 'ALEX-12: Fix callback 2026-11-10' }), 'Fix callback')
  assert.equal(compactTaskTitle({ title: 'Fix the login bug that drops authentication' }), 'Fix the login bug that drops')
})

/**
 * Guards the UI copy rules in docs/design/copy.md (C-01…C-08). Run it with
 * `node scripts/check-copy.mjs`; it exits non-zero and lists every offender.
 *
 * Only user-facing message catalogues are checked. Archived content and model
 * output are not UI copy.
 */
import { readFileSync } from 'node:fs'

const politeImperative = /请(先|使用|检查|选择|输入|重新|允许|点击|在|刷新|根据|确认|修改|发送|关闭|据此|稍候|添加|重试|稍后|用|到|按|从|开启|更新|登录|创建|联系|填|设|把|将|留|等|参|保|删|移|打|查|给|告|点|勾|拖|复|连|关|开|试)/
const apologetic = /(Please\b|Oops|Sorry|Couldn't|didn't|can't|won't)/i
const fillerTail = /[，。]请(稍后)?重试。$/

/** Strings that are legitimately phrased this way. */
const allowed = new Set([
  'Auth.retryIn', // a countdown, not a request
])

const files = ['messages/zh-CN.json', 'messages/en.json']
const problems = []
for (const file of files) {
  const catalog = JSON.parse(readFileSync(file, 'utf8'))
  const walk = (node, path) => {
    if (typeof node === 'string') {
      const key = path.join('.')
      if (allowed.has(key)) return
      const issues = []
      if (politeImperative.test(node)) issues.push('C-04 祈使句用了「请」')
      if (fillerTail.test(node)) issues.push('C-04 句尾「请重试」应由按钮承担')
      if (file.endsWith('en.json') && apologetic.test(node)) issues.push('C-03 道歉/口语化表达')
      if (issues.length) problems.push(`${file} ${key}: ${issues.join('、')} — ${node}`)
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...path, key])
    }
  }
  walk(catalog, [])
}

if (problems.length) {
  console.error(`Copy check failed: ${problems.length} string(s)\n`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log('Copy check passed: no polite imperatives, apologies or filler retry tails.')

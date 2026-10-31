/**
 * Guards the parts of docs/design/copy.md that a script can decide without
 * reading the component. Run it with `node scripts/check-copy.mjs`; it exits
 * non-zero and lists every offender.
 *
 * Whether a sentence needs 「请」 depends on what the component renders next to
 * it (C-04), so this script does not guess with a regex. It checks only:
 *
 * - C-04 label keys: button, label, placeholder, title and heading strings
 *   (picked by key name) never contain an imperative 「请」.
 * - C-04 retry-button keys: strings listed in `retryButtonKeys` are rendered
 *   next to a retry or matching action button, so they must not repeat the
 *   action as 「请重试」 / "try again". Add a key here when you put its text
 *   beside such a button; remove it when the button goes away.
 * - C-02 colloquial words in zh-CN (「没能」「打不开了」, sentence-final 吧/呢/哦/啊).
 * - C-03 apologies and interjections (「抱歉」「请稍等」, "sorry", "oops").
 *
 * It does not check English contractions (Microsoft recommends them), 「请」 in
 * full sentences, or whether a status line offers a next step. Reviewers judge
 * those against copy.md.
 */
import { readFileSync } from 'node:fs'

const imperativeQing = /(?<![邀申])请(?!求)/
const labelKey = /(Button|Label|Placeholder|Title|Heading|Tab|Tooltip|Cta)\d*$|^(label|placeholder|title|heading|button|cta)\d*$/
const zhRetry = /请.{0,12}(重试|再试)/
const enRetry = /\b(try again|retry)\b/i
const zhColloquial = /没能|没发出去|打不开了|[吧呢哦啊](?=[。！？!?，]|$)/
const zhApology = /抱歉|对不起|不好意思|哎呀|哎哟|请稍等|请稍候/
const enApology = /\b(sorry|oops|whoops|uh-oh|apologi[sz]e)\b/i

/** Keys whose component renders a retry or matching action button beside the text. */
const retryButtonKeys = new Set([
  'Issue.create.createError',
  'Auth.oauthFailed',
  'Auth.githubStartFailed',
  'Auth.googleStartFailed',
  'Auth.connectionFailed',
  'Auth.testWorkspaceFailed',
  'Invite.signOutFailed',
  'Invite.acceptFailed',
  'Invite.errors.createFailed',
  'Workspace.detail.documentNotConnected',
  'Workspace.detail.autosaveFailed',
  'IssueDetail.restoreFailed',
  'IssueDetail.history.restoreFailed',
  'IssueDetail.history.restoreIncomplete',
  'Members.readFailed',
  'Members.keptPrevious',
  'Members.addFailed',
  'Members.removeFailed',
  'Plugins.loadFailedDescription',
  'Projects.loadErrorTitle',
  'DeviceAuthorization.failed',
  'Shell.newTaskDialog.failed',
  'FeatureCopy.c_85f5c4d3',
  'FeatureCopy.c_281364f7',
  'FeatureCopy.c_3f765954',
  'AgentCopy.aCardOrTableInThisResponse',
  'AgentCopy.unableToCreateWorkspacePleaseTryAgain',
  'AgentCopy.submissionFailedYourChoicesAndAnswersAre',
])

const flatten = (node, path = [], out = new Map()) => {
  if (typeof node === 'string') out.set(path.join('.'), node)
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) flatten(value, [...path, key], out)
  return out
}

const problems = []
const report = (file, key, rule, value) => problems.push(`${file} ${key}: ${rule} — ${value}`)
for (const [file, lang] of [['messages/zh-CN.json', 'zh'], ['messages/en.json', 'en']]) {
  const strings = flatten(JSON.parse(readFileSync(file, 'utf8')))
  for (const key of retryButtonKeys) if (!strings.has(key)) report(file, key, 'retryButtonKeys 中的 key 不存在', '')
  for (const [key, value] of strings) {
    const leaf = key.split('.').at(-1)
    if (lang === 'zh') {
      if (labelKey.test(leaf) && imperativeQing.test(value)) report(file, key, 'C-04 标签/按钮/占位符/标题里不写「请」', value)
      if (retryButtonKeys.has(key) && zhRetry.test(value)) report(file, key, 'C-04 旁边已有重试按钮，文字不写「请重试」', value)
      if (zhColloquial.test(value)) report(file, key, 'C-02 口语化', value)
      if (zhApology.test(value)) report(file, key, 'C-03 道歉/客套', value)
    } else {
      if (retryButtonKeys.has(key) && enRetry.test(value)) report(file, key, 'C-04 retry button already rendered; drop "try again"', value)
      if (enApology.test(value)) report(file, key, 'C-03 apology or interjection', value)
    }
  }
}

if (problems.length) {
  console.error(`Copy check failed: ${problems.length} string(s)\n`)
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log('Copy check passed: labels without 「请」, no retry text beside retry buttons, no colloquial or apologetic copy.')

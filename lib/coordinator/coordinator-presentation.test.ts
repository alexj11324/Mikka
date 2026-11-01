// i18n-ignore-file: model prompt fixtures, not UI copy.
/**
 * Offline presentation fixture (docs/design/decisions/2026-10-31-1803-coordinator-openui-prompt.md): every
 * Coordinator path carries the generated OpenUI block exactly once, the block
 * routes each content shape below to its component with a valid example, and
 * the expected component reply for each case renders. It checks what the
 * model is told, not what a live model answers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createParser } from '@openuidev/lang-core'
import { createAgentLibrary } from '@/lib/agent-ui-catalog'
import { isOpenUI } from '@/lib/openui-lang'
import { makeSnapshot } from '@/lib/agent-kit/definition'
import { builtinAgentDefinition } from '@/lib/agent-kit/builtin'
import { executionInstructions } from '@/lib/agent-kit/execution-instructions'
import { coordinatorSystemPrompt } from '../../packages/daemon/src/coordinator/contract'
import { COORDINATOR_INSTRUCTIONS } from './instructions'
import { coordinatorPresentation, personalCoordinatorInstructions, withCoordinatorPresentation } from './native-prompt'

const library = createAgentLibrary()
const parse = (source: string) => createParser(library.toJSONSchema(), library.root).parse(source)
const presentation = coordinatorPresentation()
const occurrences = (text: string) => text.split(presentation).length - 1

const cases = [
  {
    input: '介绍一下北京的历史', shape: 'A history, timeline or anything in periods or stages: OpenUI, Steps', component: 'Steps',
    reply: `root = Stack([intro, periods, today])
intro = TextContent("北京有约三千年建城史、八百多年建都史。")
periods = Steps([early, yan, liaojin, yuan, mingqing, modern, prc])
early = StepsItem("远古 · 周口店", "约 70 万年前，北京人在周口店一带生活。")
yan = StepsItem("西周至战国 · 蓟与燕", "周初分封蓟、燕，燕国后来以蓟为都。")
liaojin = StepsItem("辽金 · 陪都到中都", "辽以此为南京，金正式建都，称中都。")
yuan = StepsItem("元 · 大都", "忽必烈营建大都，奠定今天北京城的中轴格局。")
mingqing = StepsItem("明清 · 京师", "明永乐迁都北京，修建紫禁城；清沿用为都城。")
modern = StepsItem("近代", "历经两次鸦片战争、八国联军入侵和民国时期的北平。")
prc = StepsItem("1949 年至今", "成为中华人民共和国首都，发展为国际化大都市。")
today = TextContent("故宫、天坛和胡同仍能看出这些朝代留下的格局。")`,
  },
  {
    input: '北京有哪些景点啊?', shape: 'Several places, sights, hotels, restaurants or products, recommended or listed: OpenUI, a BeCardGrid of BeImageCard', component: 'BeCardGrid',
    reply: `root = Stack([intro, cards])
intro = TextContent("北京的经典景点，按类型各选几处：")
cards = BeCardGrid([palace, wall, temple])
palace = BeImageCard("故宫", "Forbidden City Beijing", "明清两代皇宫，中轴线上的宫殿群，需提前预约。", ["皇家建筑", "需预约"])
wall = BeImageCard("八达岭长城", "Badaling Great Wall", "最常去的长城段，坡道较陡，早上人少。", ["长城", "半日"])
temple = BeImageCard("天坛", "Temple of Heaven Beijing", "明清皇帝祭天之所，祈年殿是北京的标志之一。", ["祭坛", "公园"])`,
  },
  {
    input: '我想重新安排香港的一日游，推荐三处值得去的景点。', shape: 'Several places, sights, hotels, restaurants or products, recommended or listed: OpenUI, a BeCardGrid of BeImageCard', component: 'BeImageCard',
    reply: `root = Stack([cards, order])
cards = BeCardGrid([peak, harbour, temple])
peak = BeImageCard("太平山顶", "Victoria Peak Hong Kong", "俯瞰维港两岸，傍晚上山兼看日景和夜景。", ["城市全景"])
harbour = BeImageCard("维多利亚港", "Victoria Harbour Hong Kong", "搭天星小轮过海，尖沙咀海滨看天际线。", ["海滨"])
temple = BeImageCard("黄大仙祠", "Wong Tai Sin Temple", "香港香火最旺的庙宇之一，地铁直达。", ["庙宇"])
order = BeAlert("顺序为什么这样排", "上午去黄大仙祠，下午过海，傍晚上山顶看夜景。", "info")`,
  },
]

test('every Coordinator path carries the generated presentation block exactly once', () => {
  const definition = builtinAgentDefinition()
  const runtime = { harness: 'ai_sdk' as const, model: 'fixture' }
  const paths = {
    hosted: withCoordinatorPresentation(COORDINATOR_INSTRUCTIONS),
    hostedAgentKit: withCoordinatorPresentation(executionInstructions(makeSnapshot('rev', 1, definition, COORDINATOR_INSTRUCTIONS, runtime))),
    native: personalCoordinatorInstructions(),
    // A native agent-kit snapshot freezes personalCoordinatorInstructions(), which already ends with the block.
    nativeAgentKit: withCoordinatorPresentation(executionInstructions(makeSnapshot('rev', 1, definition, personalCoordinatorInstructions(), runtime))),
  }
  for (const [name, instructions] of Object.entries(paths)) {
    assert.equal(occurrences(instructions), 1, name)
    // The daemon's codex and claude harnesses wrap the host instructions without dropping them.
    assert.equal(occurrences(coordinatorSystemPrompt(instructions)), 1, `${name} via daemon`)
  }
})

test('the block is OpenUI generateSystemPrompt output with a Markdown-or-OpenUI preamble', () => {
  assert.match(presentation, /^Presentation:\n/)
  assert.match(presentation, /Choose by the shape of the content, not its length/)
  assert.match(presentation, /Conversation, a short answer, a confirmation, a status update or a question back: plain text/)
  assert.doesNotMatch(presentation, /Prefer a natural text reply for a simple exchange/)
  assert.doesNotMatch(presentation, /Your ENTIRE response must be valid openui-lang/)
  for (const section of ['## Syntax Rules', '## Component Signatures', '## Hoisting & Streaming (CRITICAL)', '## Examples', '## Final Verification']) assert.ok(presentation.includes(section), section)
})

for (const item of cases) {
  test(`steers "${item.input}" to ${item.component}`, () => {
    assert.ok(presentation.includes(item.shape), item.shape)
    const examples = presentation.slice(presentation.indexOf('## Examples'), presentation.indexOf('## Important Rules')).split('\n\n').filter(block => block.startsWith('root = '))
    const example = examples.find(block => block.includes(`${item.component}(`))
    assert.ok(example, `an example shows ${item.component}`)
    for (const source of [example, item.reply]) {
      assert.ok(isOpenUI(source))
      const result = parse(source)
      assert.ok(result.root)
      assert.deepEqual([result.meta.errors, result.meta.unresolved, result.meta.orphaned, result.meta.incomplete], [[], [], [], false], source)
      assert.match(source, new RegExp(`\\b${item.component}\\(`))
    }
  })
}

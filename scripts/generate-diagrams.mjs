// Draws the README diagrams as orthogonal SVG in English and Chinese, light and
// dark: the architecture and the way a task moves through Mikka. Run
// `node scripts/generate-diagrams.mjs` after changing a box or a flow, and
// commit the files it writes to docs/assets.
import { chevron, diamond, legend, LEGEND_TEXT, line, rectBox, svg, tag, writeDiagram } from './diagram-svg.mjs'

const ROOT = process.cwd()

// ---- Architecture -------------------------------------------------------

// Column x ranges and the two merge buses.
const C1 = [20, 200]
const C2 = [400, 600]
const C3 = [740, 920]
const C4 = [1000, 1200]
const BUS1 = 370
const BUS2 = 650

// id: [column, y center, height, planned]
const ARCH_BOXES = {
  web: [C1, 170, 60, false],
  tg: [C1, 240, 48, false],
  notify: [C1, 320, 60, false],
  cron: [C1, 432, 60, false],
  mcpc: [C1, 520, 60, false],
  stripe: [[470, 600], 120, 48, false],
  api: [C2, 240, 60, false],
  mcp: [C2, 520, 60, false],
  db: [C3, 70, 60, false],
  factory: [C3, 250, 76, false],
  coord: [C3, 380, 60, false],
  daemon: [C3, 520, 60, false],
  worker: [C4, 70, 60, true],
  linear: [C4, 190, 48, false],
  monitor: [C4, 270, 60, false],
  cloud: [C4, 380, 60, false],
  agents: [[1000, 1165], 520, 60, false],
  vault: [C4, 680, 60, true],
}

const ARCH_TEXT = {
  en: {
    web: ['Web and desktop app', 'iOS app'], tg: ['Telegram, Slack'], notify: ['GitHub, Gmail,', 'Calendar, Notion,', 'Slack'],
    cron: ['Minute Worker', 'wakes, schedules'], mcpc: ['Claude Code, Codex', 'as MCP clients'],
    stripe: ['Stripe'],
    api: ['Next.js app on Vercel', 'API, device API /v1'], mcp: ['MCP server', 'OAuth 2.1'],
    db: ['Postgres', 'Neon'], factory: ['Factory stages', 'review, verification,', 'acceptance'],
    coord: ['Coordinator', 'workflow, triage'], daemon: ['Your computer or', 'SSH host · daemon'],
    worker: ['Linear sync Worker', 'off by default'], linear: ['Linear'],
    monitor: ['Monitoring', 'incidents to issues'], cloud: ['Mikka Cloud · managed', 'E2B, a desktop per bot'],
    agents: ['Agent CLI', 'a worktree per run'], vault: ['Credential vault', 'KMS, login broker'],
    tWebhook: 'webhook', tNotify: 'webhooks, triggers', tMcp: 'MCP', tDb: 'reads, writes',
    tEvents: 'events', tDispatch: 'runs', tTools: 'report, ask, blocked', tLinear: 'webhooks, API',
    pActions: 'approved writes', tWake: 'wake', tBilling: 'checkout', tCloudRun: 'Agents on Mikka Cloud', tCloudWake: 'wake',
    title: 'Mikka architecture',
  },
  zh: {
    web: ['Web 与桌面应用', 'iOS 应用'], tg: ['Telegram、Slack'], notify: ['GitHub、Gmail、', '日历、Notion、', 'Slack'],
    cron: ['每分钟 Worker', '唤醒、定时任务'], mcpc: ['Claude Code、Codex', '作为 MCP 客户端'],
    stripe: ['Stripe'],
    api: ['Next.js 应用（Vercel）', 'API、设备 API /v1'], mcp: ['MCP server', 'OAuth 2.1'],
    db: ['Postgres', 'Neon'], factory: ['Factory 阶段', '审查、验证、', '验收'],
    coord: ['Coordinator', 'workflow、分诊'], daemon: ['你的电脑或 SSH 主机', 'Mikka daemon'],
    worker: ['Linear 同步 Worker', '默认关闭'], linear: ['Linear'],
    monitor: ['监控', '故障回流为 issue'], cloud: ['Mikka Cloud · 托管', 'E2B，每个 bot 一个桌面'],
    agents: ['Agent CLI', '每次运行独立 worktree'], vault: ['凭据保管库', 'KMS、登录 broker'],
    tWebhook: 'webhook', tNotify: 'webhook、触发器', tMcp: 'MCP', tDb: '读写',
    tEvents: '事件', tDispatch: '派发运行', tTools: '汇报、提问、阻塞', tLinear: 'webhook、API',
    pActions: '审批后写入', tWake: '唤醒', tBilling: '支付', tCloudRun: '在 Mikka Cloud 上运行的 Agent', tCloudWake: '唤醒',
    title: 'Mikka 架构',
  },
}

function archFlows(t, p) {
  return [
    // Entry points into the app, merged on BUS1.
    ...line([[C1[1], 170], [BUS1, 170], [BUS1, 240]], p), ...chevron(BUS1, 210, 'down', p),
    ...line([[C1[1], 320], [BUS1, 320], [BUS1, 240]], p), ...chevron(BUS1, 272, 'up', p),
    ...line([[C1[1], 240], [C2[0], 240]], p), ...chevron(388, 240, 'right', p),
    ...tag(285, 240, t.tWebhook, p), ...tag(285, 320, t.tNotify, p),
    // Connected-app writes run after approval (on in production).
    ...line([[420, 270], [420, 368], [110, 368], [110, 350]], p), ...chevron(110, 358, 'up', p),
    ...tag(290, 368, t.pActions, p),
    // Card checks and top-ups go through Stripe Checkout; Stripe answers with webhooks.
    ...line([[535, 144], [535, 210]], p), ...chevron(535, 202, 'down', p), ...chevron(535, 152, 'up', p),
    ...tag(535, 177, t.tBilling, p),
    // External MCP clients.
    ...line([[C1[1], 520], [C2[0], 520]], p), ...chevron(388, 520, 'right', p), ...tag(300, 520, t.tMcp, p),
    // App state in Postgres.
    ...line([[430, 210], [430, 70], [C3[0], 70]], p), ...chevron(728, 70, 'right', p), ...tag(670, 70, t.tDb, p),
    // Linear sync: built, switched off by a PostHog flag.
    ...line([[C3[1], 70], [C4[0], 70]], p, true), ...chevron(934, 70, 'left', p), ...chevron(986, 70, 'right', p),
    ...line([[1100, 100], [1100, 166]], p, true), ...chevron(1100, 158, 'down', p), ...chevron(1100, 108, 'up', p),
    ...tag(1100, 133, t.tLinear, p, true),
    // API and MCP events merged on BUS2 into the Coordinator.
    ...line([[C2[1], 240], [BUS2, 240], [BUS2, 380]], p), ...chevron(BUS2, 300, 'down', p),
    ...line([[C2[1], 520], [BUS2, 520], [BUS2, 380]], p), ...chevron(BUS2, 470, 'up', p),
    ...line([[BUS2, 380], [C3[0], 380]], p), ...chevron(731, 380, 'right', p), ...tag(688, 380, t.tEvents, p),
    // The minute Worker wakes the Coordinator, runs schedules and sends briefings.
    ...line([[C1[1], 432], [BUS2, 432]], p), ...chevron(BUS2 - 14, 432, 'right', p),
    ...tag(300, 432, t.tWake, p),
    // Factory stages on top of the Coordinator, fed by monitoring: switched on in production.
    ...line([[830, 288], [830, 350]], p), ...chevron(830, 300, 'up', p), ...chevron(830, 340, 'down', p),
    ...line([[C4[0], 270], [C3[1], 270]], p), ...chevron(932, 270, 'left', p),
    // Coordinator wake of a bot's cloud computer was verified in production.
    ...line([[C3[1], 380], [C4[0], 380]], p), ...chevron(988, 380, 'right', p), ...tag(960, 380, t.tCloudWake, p),
    ...line([[830, 410], [830, 490]], p), ...chevron(830, 482, 'down', p), ...tag(830, 446, t.tDispatch, p),
    ...line([[C3[1], 520], [C4[0], 520]], p), ...chevron(988, 520, 'right', p),
    // Agents on Mikka Cloud need real subscription-backed inference acceptance.
    ...line([[1045, 410], [1045, 490]], p, true), ...chevron(1045, 422, 'up', p), ...chevron(1045, 478, 'down', p),
    ...tag(1045, 450, t.tCloudRun, p, true),
    // Web sub-agents on the cloud computer log in through the vault's broker; live acceptance is pending.
    ...line([[1185, 410], [1185, 650]], p, true), ...chevron(1185, 642, 'down', p),
    // Agents report, ask and say they are blocked through the MCP worker tools.
    ...line([[1050, 550], [1050, 600], [500, 600], [500, 550]], p),
    ...chevron(950, 600, 'left', p), ...chevron(500, 566, 'up', p), ...tag(800, 600, t.tTools, p),
  ]
}

function drawArchitecture(lang, p) {
  const t = ARCH_TEXT[lang]
  return svg(1220, 820, t.title, [
    ...archFlows(t, p),
    ...Object.entries(ARCH_BOXES).flatMap(([id, [[x0, x1], yc, h, planned]]) => rectBox(x0, x1, yc, h, t[id], p, planned)),
    ...legend(776, LEGEND_TEXT[lang], p),
  ], p)
}

// ---- Task flow ----------------------------------------------------------

// Columns of the main row; the two diamonds sit between them.
const X1 = [20, 200]
const X2 = [250, 430]
const X3 = [680, 860]
const X4 = [930, 1130]
const RAIL = 1190

// id: [x range, y center, height, planned]
const FLOW_BOXES = {
  request: [X1, 230, 60, false],
  triage: [X2, 230, 48, false],
  dispatch: [X3, 230, 48, false],
  agent: [X4, 230, 60, false],
  asks: [X4, 70, 60, false],
  answer: [X3, 70, 60, false],
  details: [[440, 620], 390, 48, false],
  review: [X4, 520, 60, false],
  approve: [[430, 610], 520, 60, false],
  ship: [X1, 520, 60, false],
}

const FLOW_TEXT = {
  en: {
    request: ['New request', 'chat, Telegram,', 'Slack, MCP'], triage: ['Coordinator triages'],
    dispatch: ['Dispatch run'], agent: ['Agent runs'],
    asks: ['Coordinator asks', 'for clarification'], answer: ['Human provides input'],
    details: ['Human adds details'], review: ['Review and verification', 'Agents run'],
    approve: ['Acceptance', 'and release'], ship: ['Ship and monitor'],
    clear: ['Clear?'], passes: ['Ready', 'to ship?'],
    tClear: 'Clear', tUnclear: 'Needs clarification', tAsks: 'Asks, blocked', tAnswer: 'Answer to the run',
    pFinished: 'Finished', pFix: 'Needs a fix', pPasses: 'Ready', pIncident: 'New issue',
    title: 'How a task moves through Mikka',
  },
  zh: {
    request: ['新请求', '对话、Telegram、', 'Slack、MCP'], triage: ['Coordinator 分诊'],
    dispatch: ['派发运行'], agent: ['Agent 运行'],
    asks: ['Coordinator', '请求澄清'], answer: ['人工提供输入'],
    details: ['人工补充细节'], review: ['审查与验证', 'Agent 运行'],
    approve: ['验收与发布'], ship: ['上线并监控'],
    clear: ['是否清楚？'], passes: ['是否可以', '上线？'],
    tClear: '清楚', tUnclear: '需要澄清', tAsks: '提问、阻塞', tAnswer: '答案送回运行',
    pFinished: '完成', pFix: '需要修复', pPasses: '可以上线', pIncident: '新 issue',
    title: '任务在 Mikka 中的流转',
  },
}

function flowEdges(t, p) {
  return [
    // Main row: request, triage, the clarity check, dispatch, the agent.
    ...line([[X1[1], 230], [X2[0], 230]], p), ...chevron(242, 230, 'right', p),
    ...line([[X2[1], 230], [470, 230]], p), ...chevron(462, 230, 'right', p),
    ...line([[590, 230], [X3[0], 230]], p), ...chevron(672, 230, 'right', p), ...tag(628, 230, t.tClear, p),
    ...line([[X3[1], 230], [X4[0], 230]], p), ...chevron(922, 230, 'right', p),
    // Clarification before dispatch: an unclear request goes back to the person (Factory routing, on in production).
    ...line([[530, 290], [530, 366]], p), ...chevron(530, 358, 'down', p), ...tag(530, 328, t.tUnclear, p),
    ...line([[440, 390], [340, 390], [340, 254]], p), ...chevron(340, 264, 'up', p),
    // Clarification during a run: the agent asks, the person answers, the answer goes back.
    ...line([[1060, 200], [1060, 100]], p), ...chevron(1060, 110, 'up', p), ...tag(1060, 150, t.tAsks, p),
    ...line([[X4[0], 70], [X3[1], 70]], p), ...chevron(868, 70, 'left', p),
    ...line([[770, 100], [770, 150], [970, 150], [970, 200]], p), ...chevron(970, 192, 'down', p),
    ...tag(870, 150, t.tAnswer, p),
    // Factory loop, on in production: review, a fix when it fails, acceptance and release, monitoring.
    ...line([[X4[1], 230], [RAIL, 230], [RAIL, 520], [X4[1], 520]], p),
    ...chevron(RAIL, 300, 'down', p), ...chevron(1140, 520, 'left', p), ...tag(RAIL, 375, t.pFinished, p),
    ...line([[X4[0], 520], [826, 520]], p), ...chevron(834, 520, 'left', p),
    ...line([[770, 464], [770, 254]], p), ...chevron(770, 262, 'up', p), ...tag(770, 360, t.pFix, p),
    ...line([[714, 520], [610, 520]], p), ...chevron(618, 520, 'left', p), ...tag(662, 520, t.pPasses, p),
    ...line([[430, 520], [X1[1], 520]], p), ...chevron(208, 520, 'left', p),
    ...line([[110, 490], [110, 254]], p), ...chevron(110, 262, 'up', p), ...tag(110, 380, t.pIncident, p),
  ]
}

function drawTaskFlow(lang, p) {
  const t = FLOW_TEXT[lang]
  return svg(1240, 670, t.title, [
    ...flowEdges(t, p),
    ...Object.entries(FLOW_BOXES).flatMap(([id, [[x0, x1], yc, h, planned]]) => rectBox(x0, x1, yc, h, t[id], p, planned)),
    ...diamond(530, 230, 60, t.clear, p),
    ...diamond(770, 520, 56, t.passes, p),
    ...legend(630, LEGEND_TEXT[lang], p),
  ], p)
}

writeDiagram(ROOT, 'architecture', drawArchitecture)
writeDiagram(ROOT, 'task-flow', drawTaskFlow)

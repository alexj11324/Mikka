// Draws the README architecture diagram as orthogonal SVG: English and Chinese,
// light and dark. Solid boxes and lines are shipped; dashed ones are on the
// roadmap. Run `node scripts/generate-architecture.mjs` after changing a box or
// a flow, and commit the four files it writes to docs/assets.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, 'docs', 'assets')
const W = 1220
const H = 820
const FONT = '-apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Helvetica, Arial, &quot;PingFang SC&quot;, &quot;Noto Sans CJK SC&quot;, &quot;Microsoft YaHei&quot;, sans-serif'

const PALETTES = {
  light: { ink: '#111111', box: '#ffffff', blue: '#1a5cff', tag: '#ffffff', muted: '#59636e' },
  dark: { ink: '#e6edf3', box: '#0d1117', blue: '#4d82ff', tag: '#ffffff', muted: '#9198a1' },
}

// Column x ranges and the two merge buses.
const C1 = [20, 200]
const C2 = [400, 600]
const C3 = [740, 920]
const C4 = [1000, 1200]
const BUS1 = 370
const BUS2 = 650

// id: [column, y center, height, planned]
const BOXES = {
  web: [C1, 170, 48, false],
  tg: [C1, 240, 48, false],
  notify: [C1, 320, 60, false],
  sched: [C1, 432, 60, true],
  mcpc: [C1, 520, 60, false],
  vault: [C1, 640, 60, true],
  api: [C2, 240, 60, false],
  mcp: [C2, 520, 60, false],
  db: [C3, 70, 60, false],
  factory: [C3, 250, 76, true],
  coord: [C3, 380, 60, false],
  daemon: [C3, 520, 60, false],
  worker: [C4, 70, 60, false],
  linear: [C4, 190, 48, false],
  monitor: [C4, 270, 60, true],
  cloud: [C4, 380, 60, true],
  agents: [C4, 520, 60, false],
  cu: [C4, 680, 60, true],
}

const TEXT = {
  en: {
    web: ['Web app'], tg: ['Telegram'], notify: ['GitHub, Gmail,', 'Notion, Slack'],
    sched: ['Scheduler', 'scheduled tasks'], mcpc: ['Claude Code, Codex', 'as MCP clients'],
    vault: ['Credential vault', 'controlled browser'],
    api: ['API and server actions', 'incl. device API /v1'], mcp: ['MCP server', 'OAuth 2.1'],
    db: ['Postgres', 'Neon'], factory: ['Factory stages', 'review, verification,', 'release approval'],
    coord: ['Coordinator', 'workflow, triage'], daemon: ['Mikka daemon', 'on your machine'],
    worker: ['Linear sync Worker', 'Cloudflare'], linear: ['Linear'],
    monitor: ['Monitoring', 'incidents to issues'], cloud: ['Cloud computer', 'E2B, a desktop per bot'],
    agents: ['Coding agent CLI', 'one worktree per run'], cu: ['Computer use', 'local cua-driver'],
    tWebhook: 'webhook', tNotify: 'webhooks, triggers', tMcp: 'MCP', tDb: 'reads, writes',
    tEvents: 'events', tDispatch: 'dispatch run', tTools: 'worker tools', tLinear: 'webhooks, API',
    pActions: 'actions after approval', pWake: 'wake', pSecure: 'secure input', pHandoff: 'handoff',
    lShipped: 'Shipped', lPlanned: 'Planned', lFlow: 'Data flow', lPlannedFlow: 'Planned flow',
    title: 'Mikka architecture',
  },
  zh: {
    web: ['Web 应用'], tg: ['Telegram'], notify: ['GitHub、Gmail、', 'Notion、Slack'],
    sched: ['Scheduler', '定时任务'], mcpc: ['Claude Code、Codex', '作为 MCP 客户端'],
    vault: ['凭据保管库', '受控浏览器'],
    api: ['API 与 server actions', '含设备 API /v1'], mcp: ['MCP server', 'OAuth 2.1'],
    db: ['Postgres', 'Neon'], factory: ['Factory 阶段', '审查、验证、', '人工发布审批'],
    coord: ['Coordinator', 'workflow、分诊'], daemon: ['Mikka daemon', '运行在你的设备上'],
    worker: ['Linear 同步 Worker', 'Cloudflare'], linear: ['Linear'],
    monitor: ['监控', '故障回流为 issue'], cloud: ['云端电脑', 'E2B，每个 bot 一个桌面'],
    agents: ['Coding agent CLI', '每次运行独立 worktree'], cu: ['Computer use', '本机 cua-driver'],
    tWebhook: 'webhook', tNotify: 'webhook、触发器', tMcp: 'MCP', tDb: '读写',
    tEvents: '事件', tDispatch: '派发运行', tTools: 'worker 工具', tLinear: 'webhook、API',
    pActions: '审批后执行操作', pWake: '唤醒', pSecure: '安全输入', pHandoff: '接续',
    lShipped: '已上线', lPlanned: '规划中', lFlow: '数据流', lPlannedFlow: '规划中的数据流',
    title: 'Mikka 架构',
  },
}

const esc = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// Rough rendered width at 14px: CJK glyphs are square, Latin glyphs about half as wide.
const textWidth = s => [...s].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e80 ? 14 : 7.6), 0)

function rectBox(x0, x1, yc, h, lines, p, planned) {
  const dash = planned ? ' stroke-dasharray="7 5"' : ''
  const first = yc - ((lines.length - 1) * 19) / 2 + 5
  return [
    `<rect x="${x0}" y="${yc - h / 2}" width="${x1 - x0}" height="${h}" fill="${p.box}" stroke="${p.ink}" stroke-width="2.5"${dash}/>`,
    ...lines.map((line, i) => `<text x="${(x0 + x1) / 2}" y="${first + i * 19}" text-anchor="middle" font-size="15" fill="${p.ink}">${esc(line)}</text>`),
  ]
}

function box(id, lines, p) {
  const [[x0, x1], yc, h, planned] = BOXES[id]
  return rectBox(x0, x1, yc, h, lines, p, planned)
}

function tag(cx, cy, label, p, planned = false) {
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

function line(points, p, planned = false) {
  const dash = planned ? ' stroke-dasharray="7 5"' : ''
  const d = 'M' + points.map(([x, y]) => `${x} ${y}`).join(' L')
  return [`<path d="${d}" fill="none" stroke="${p.ink}" stroke-width="2.5"${dash}/>`]
}

function chevron(x, y, direction, p) {
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

function legend(t, p) {
  const y = 776
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

function flows(t, p) {
  return [
    // Entry points into the API, merged on BUS1.
    ...line([[C1[1], 170], [BUS1, 170], [BUS1, 240]], p), ...chevron(BUS1, 210, 'down', p),
    ...line([[C1[1], 320], [BUS1, 320], [BUS1, 240]], p), ...chevron(BUS1, 272, 'up', p),
    ...line([[C1[1], 240], [C2[0], 240]], p), ...chevron(388, 240, 'right', p),
    ...tag(285, 240, t.tWebhook, p), ...tag(285, 320, t.tNotify, p),
    // Planned: connected-app actions go back out after approval.
    ...line([[420, 270], [420, 368], [110, 368], [110, 350]], p, true), ...chevron(110, 358, 'up', p),
    ...tag(290, 368, t.pActions, p, true),
    // External MCP clients.
    ...line([[C1[1], 520], [C2[0], 520]], p), ...chevron(388, 520, 'right', p), ...tag(300, 520, t.tMcp, p),
    // Planned: credential requests from agents reach the vault through MCP.
    ...line([[C1[1], 640], [440, 640], [440, 550]], p, true), ...chevron(440, 566, 'up', p),
    ...tag(320, 640, t.pSecure, p, true),
    // App state in Postgres.
    ...line([[500, 210], [500, 70], [C3[0], 70]], p), ...chevron(728, 70, 'right', p), ...tag(620, 70, t.tDb, p),
    // Linear sync.
    ...line([[C3[1], 70], [C4[0], 70]], p), ...chevron(934, 70, 'left', p), ...chevron(986, 70, 'right', p),
    ...line([[1100, 100], [1100, 166]], p), ...chevron(1100, 158, 'down', p), ...chevron(1100, 108, 'up', p),
    ...tag(1100, 133, t.tLinear, p),
    // API and MCP events merged on BUS2 into the Coordinator.
    ...line([[C2[1], 240], [BUS2, 240], [BUS2, 380]], p), ...chevron(BUS2, 300, 'down', p),
    ...line([[C2[1], 520], [BUS2, 520], [BUS2, 380]], p), ...chevron(BUS2, 470, 'up', p),
    ...line([[BUS2, 380], [C3[0], 380]], p), ...chevron(731, 380, 'right', p), ...tag(688, 380, t.tEvents, p),
    // Planned: the scheduler wakes the Coordinator through the same bus.
    ...line([[C1[1], 432], [BUS2, 432]], p, true), ...chevron(BUS2 - 14, 432, 'right', p),
    ...tag(300, 432, t.pWake, p, true),
    // Planned: Factory stages on top of the Coordinator, fed by monitoring.
    ...line([[830, 288], [830, 350]], p, true), ...chevron(830, 300, 'up', p), ...chevron(830, 340, 'down', p),
    ...line([[C4[0], 270], [C3[1], 270]], p, true), ...chevron(932, 270, 'left', p),
    // Dispatch: your machine today, the cloud computer later.
    ...line([[C3[1], 380], [C4[0], 380]], p, true), ...chevron(988, 380, 'right', p),
    ...line([[830, 410], [830, 490]], p), ...chevron(830, 482, 'down', p), ...tag(830, 446, t.tDispatch, p),
    ...line([[C3[1], 520], [C4[0], 520]], p), ...chevron(988, 520, 'right', p),
    // Planned: runs hand off between machines.
    ...line([[1100, 410], [1100, 490]], p, true), ...chevron(1100, 422, 'up', p), ...chevron(1100, 478, 'down', p),
    ...tag(1100, 450, t.pHandoff, p, true),
    // Planned: local computer use for the agent.
    ...line([[1150, 550], [1150, 650]], p, true), ...chevron(1150, 642, 'down', p),
    // Agents report back through the MCP worker tools.
    ...line([[1050, 550], [1050, 600], [500, 600], [500, 550]], p),
    ...chevron(950, 600, 'left', p), ...chevron(500, 566, 'up', p), ...tag(800, 600, t.tTools, p),
  ]
}

export function drawArchitecture(lang, theme) {
  const p = PALETTES[theme]
  const t = TEXT[lang]
  const elements = [
    ...flows(t, p),
    ...Object.keys(BOXES).flatMap(id => box(id, t[id], p)),
    ...legend(t, p),
  ]
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="${esc(t.title)}">
  <title>${esc(t.title)}</title>
  ${elements.join('\n  ')}
</svg>
`
}

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const lang of Object.keys(TEXT)) {
  for (const theme of Object.keys(PALETTES)) {
    const file = path.join(OUT_DIR, `architecture${lang === 'en' ? '' : '-zh'}-${theme}.svg`)
    fs.writeFileSync(file, drawArchitecture(lang, theme))
    console.log(path.relative(ROOT, file))
  }
}

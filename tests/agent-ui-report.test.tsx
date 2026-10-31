import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { createParser } from '@openuidev/lang-core'
import messages from '../messages/en.json'
import { agentComponentCatalog, createAgentLibrary } from '../lib/agent-ui-catalog'
import { detectAgentUISource } from '../lib/agent-ui-source'
import { AgentGenerativeUI } from '../components/workspace/agent-generative-ui'

const library = createAgentLibrary()
const parser = createParser(library.toJSONSchema(), library.root)

/** One sample per component added for reports and question inputs. */
const samples = {
  BarChart: 'root = BarChart(["Q1", "Q2", "Q3"], [{name: "Revenue", values: [12, 18, 9]}, {name: "Cost", values: [8, 9, 7]}], true, "k")',
  LineChart: 'root = LineChart(["Mon", "Tue", "Wed"], [{name: "Visits", values: [120, 180, 150]}], "%")',
  Separator: 'root = Stack([TextContent("Above"), Separator(), TextContent("Below")])',
  BeAlert: 'root = BeAlert("Sample data", "Figures below are illustrative.", "warning")',
  BeTable: 'root = BeTable(["Team", "Done"], [["Design", 3], ["Build", 5]])',
  BeTabs: 'root = BeTabs([{title: "Overview", children: [TextContent("First pane")]}, {title: "Detail", children: [TextContent("Second pane")]}])',
  BeCollapsible: 'root = BeCollapsible("More detail", [TextContent("Hidden note")], true)',
  BeTimeline: 'root = BeTimeline([{date: "2026-11-02", title: "Kickoff", description: "Agree on scope."}, {date: "2026-11-16", title: "Review", meta: "Proposed"}])',
  BeFileTree: 'root = BeFileTree(["app/page.tsx", "lib/report.ts"])',
  BeCitations: 'root = BeCitations([{title: "OpenUI docs", url: "https://www.openui.com/docs"}])',
  BeFileDiff: 'root = BeFileDiff("lib/report.ts", "-const a = 1\\n+const a = 2\\n context", "tsx")',
} as const

function render(response: string) {
  return renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}>
    <AgentGenerativeUI response={response} isStreaming={false} onAction={() => {}} />
  </NextIntlClientProvider>)
}

test('Report components parse, are detected as OpenUI and render through the real renderer', () => {
  for (const [name, source] of Object.entries(samples)) {
    assert.ok(name in agentComponentCatalog, name)
    const parsed = parser.parse(source)
    assert.ok(parsed.root, name)
    assert.deepEqual(parsed.meta.errors, [], name)
    assert.deepEqual(parsed.meta.unresolved, [], name)
    assert.equal(detectAgentUISource(source.replace(/^root = /, '')).isOpenUI, true, name)
    const html = render(source)
    assert.doesNotMatch(html, /Unable to|could not be displayed|unsupported/i, name)
  }
  assert.match(render(samples.BarChart), /data-slot="chart"/)
  assert.match(render(samples.BarChart), /var\(--chart-2\)/)
  assert.doesNotMatch(render(samples.BarChart) + render(samples.LineChart), /#[0-9a-f]{6}\b|rgb\(/i)
  assert.match(render(samples.Separator), /role="separator"/)
  assert.match(render(samples.BeAlert), /Figures below are illustrative/)
  assert.match(render(samples.BeTable), /Design|Team/)
  assert.match(render(samples.BeTabs), /First pane/)
  assert.match(render(samples.BeCollapsible), /Hidden note/)
  assert.match(render(samples.BeTimeline), /Kickoff/)
  assert.match(render(samples.BeFileTree), /report\.ts/)
  assert.match(render(samples.BeCitations), /OpenUI docs/)
  assert.match(render(samples.BeFileDiff), /lib\/report\.ts/)
})

test('Report components reject invalid props', () => {
  const { BarChart, LineChart, BeTable, BeTimeline, BeAlert, BeCitations, BeFileTree, BeTabs } = agentComponentCatalog
  const chart = { labels: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }] }
  assert.equal(BarChart.props.safeParse(chart).success, true)
  assert.equal(BarChart.props.safeParse({ ...chart, series: [{ name: 'S', values: [1] }] }).success, false)
  assert.equal(LineChart.props.safeParse({ ...chart, series: [] }).success, false)
  assert.equal(LineChart.props.safeParse({ ...chart, series: Array(6).fill(chart.series[0]) }).success, false)
  assert.equal(BarChart.props.safeParse({ labels: Array(25).fill('x'), series: [{ name: 'S', values: Array(25).fill(1) }] }).success, false)
  assert.equal(BarChart.props.safeParse({ ...chart, series: [{ name: 'S', values: [1, Infinity] }] }).success, false)
  assert.equal(BeTable.props.safeParse({ columns: Array(7).fill('c'), rows: [] }).success, false)
  assert.equal(BeTimeline.props.safeParse({ events: [{ date: 'next week', title: 'Kickoff' }] }).success, false)
  assert.equal(BeAlert.props.safeParse({ title: 'T', description: 'D', variant: 'loud' }).success, false)
  assert.equal(BeCitations.props.safeParse({ sources: [{ title: 'x', url: 'javascript:alert(1)' }] }).success, false)
  assert.equal(BeFileTree.props.safeParse({ paths: ['../etc/passwd'] }).success, false)
  assert.equal(BeFileTree.props.safeParse({ paths: ['/etc/passwd'] }).success, false)
  assert.equal(BeTabs.props.safeParse({ items: [] }).success, false)
  for (const source of ['root = BarChart("A", [])', 'root = LineChart(["A"], "S")', 'root = BeTable("Team", [])']) {
    assert.ok(parser.parse(source).meta.errors.length > 0, source)
  }
  // A ragged series the schema refinement would reject still renders without throwing.
  assert.match(render('root = BarChart(["A", "B"], [{name: "S", values: [1]}])'), /data-slot="chart"/)
  assert.equal('ToolResult' in agentComponentCatalog, false)
})

const questionCard = `root = BeQuestions("Planning a team offsite", [
  {id: "city", title: "Which city?", input: "select", options: [{value: "lisbon", label: "Lisbon"}, {value: "berlin", label: "Berlin"}]},
  {id: "remote", title: "Allow remote attendance?", input: "switch"},
  {id: "budget", title: "Budget per person", input: "slider", range: {min: 200, max: 1000, step: 100, unit: " EUR"}},
  {id: "dates", title: "Which dates?", input: "dateRange"}
])`

test('BeQuestions accepts beUI Select, Switch, slider and date range inputs on the existing submit path', () => {
  const parsed = parser.parse(questionCard)
  assert.ok(parsed.root)
  assert.deepEqual(parsed.meta.errors, [])
  const html = render(questionCard)
  assert.match(html, /Which city\?/)
  const { BeQuestions } = agentComponentCatalog
  const base = { context: 'Offsite' }
  assert.equal(BeQuestions.props.safeParse({ ...base, questions: [{ id: 'a', title: 'Pick', input: 'select' }] }).success, false)
  assert.equal(BeQuestions.props.safeParse({ ...base, questions: [{ id: 'a', title: 'Budget', input: 'slider' }] }).success, false)
  assert.equal(BeQuestions.props.safeParse({ ...base, questions: [{ id: 'a', title: 'Budget', input: 'slider', range: { min: 5, max: 1 } }] }).success, false)
  assert.equal(BeQuestions.props.safeParse({ ...base, questions: [{ id: 'a', title: 'Remote?', input: 'switch' }] }).success, true)
  assert.equal(BeQuestions.props.safeParse({ ...base, questions: [{ id: 'a', title: 'Upload', input: 'file' }] }).success, false)
})

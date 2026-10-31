import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import { createParser } from '@openuidev/lang-core'
import messages from '../messages/en.json'
import chineseMessages from '../messages/zh-CN.json'
import { agentComponentCatalog, createAgentLibrary } from '../lib/agent-ui-catalog'
import { detectAgentUISource } from '../lib/agent-ui-source'
import { actionPrompt, AgentGenerativeUI } from '../components/workspace/agent-generative-ui'
import { ReplyBubbles } from '../components/workspace/agent-text-bubble'

const library = createAgentLibrary()
const parser = createParser(library.toJSONSchema(), library.root)

/** One sample per component added for reports and question inputs. */
const samples = {
  BarChart: 'root = BarChart(["Q1", "Q2", "Q3"], [{name: "Revenue", values: [12, 18, 9]}, {name: "Cost", values: [8, 9, 7]}], true, "k")',
  LineChart: 'root = LineChart(["Mon", "Tue", "Wed"], [{name: "Visits", values: [120, 180, 150]}], "%")',
  AreaChart: 'root = AreaChart(["Mon", "Tue", "Wed"], [{name: "Organic", values: [12, 14, 18]}, {name: "Paid", values: [5, 6, 7]}])',
  DonutChart: 'root = DonutChart([{name: "Direct", value: 42}, {name: "Search", value: 36}], "", "Total")',
  RadialChart: 'root = RadialChart("Quota", 60, 100, "k")',
  Separator: 'root = Stack([TextContent("Above"), Separator(), TextContent("Below")])',
  BeAlert: 'root = BeAlert("Sample data", "Figures below are illustrative.", "warning")',
  BeTable: 'root = BeTable(["Team", "Done"], [["Design", 3], ["Build", 5]])',
  BeTabs: 'root = BeTabs([{title: "Overview", children: [TextContent("First pane")]}, {title: "Detail", children: [TextContent("Second pane")]}])',
  BeCollapsible: 'root = BeCollapsible("More detail", [TextContent("Hidden note")], true)',
  BeFileTree: 'root = BeFileTree(["app/page.tsx", "lib/report.ts"])',
  BeCitations: 'root = BeCitations([{title: "OpenUI docs", url: "https://www.openui.com/docs"}])',
  BeFileDiff: 'root = BeFileDiff("lib/report.ts", "-const a = 1\\n+const a = 2\\n context", "tsx")',
} as const

function render(response: string, locale: 'en' | 'zh-CN' = 'en') {
  return renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={locale === 'en' ? messages : chineseMessages}>
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
  assert.match(render(samples.BarChart), /var\(--chart-1\)/)
  assert.doesNotMatch(render(samples.BarChart) + render(samples.LineChart) + render(samples.AreaChart) + render(samples.DonutChart), /#[0-9a-f]{6}\b|rgb\(/i)
  // ReUI area and donut charts render through the shared chart container.
  assert.match(render(samples.AreaChart), /data-slot="chart"/)
  assert.match(render(samples.DonutChart), /data-slot="chart"/)
  assert.match(render(samples.RadialChart), /data-slot="chart"/)
  assert.match(render(samples.RadialChart), /var\(--chart-1\)/)
  assert.equal(agentComponentCatalog.RadialChart.props.safeParse({ label: 'Quota', used: 1, limit: 0 }).success, false)
  assert.match(render(samples.Separator), /role="separator"/)
  assert.match(render(samples.BeAlert), /Figures below are illustrative/)
  assert.match(render(samples.BeTable), /Design|Team/)
  assert.match(render(samples.BeTabs), /First pane/)
  assert.match(render(samples.BeCollapsible), /Hidden note/)
  assert.match(render(samples.BeFileTree), /report\.ts/)
  assert.match(render(samples.BeCitations), /OpenUI docs/)
  assert.match(render(samples.BeFileDiff), /lib\/report\.ts/)
})

test('Report components reject invalid props', () => {
  const { DonutChart } = agentComponentCatalog
  assert.equal(DonutChart.props.safeParse({ slices: [{ name: 'A', value: 1 }, { name: 'B', value: 2 }] }).success, true)
  assert.equal(DonutChart.props.safeParse({ slices: [{ name: 'A', value: 1 }] }).success, false)
  assert.equal(DonutChart.props.safeParse({ slices: [{ name: 'A', value: -1 }, { name: 'B', value: 2 }] }).success, false)
  const { BarChart, LineChart, BeTable, BeAlert, BeCitations, BeFileTree, BeTabs } = agentComponentCatalog
  const chart = { labels: ['A', 'B'], series: [{ name: 'S', values: [1, 2] }] }
  assert.equal(BarChart.props.safeParse(chart).success, true)
  assert.equal(BarChart.props.safeParse({ ...chart, series: [{ name: 'S', values: [1] }] }).success, false)
  assert.equal(LineChart.props.safeParse({ ...chart, series: [] }).success, false)
  assert.equal(LineChart.props.safeParse({ ...chart, series: Array(6).fill(chart.series[0]) }).success, false)
  assert.equal(BarChart.props.safeParse({ labels: Array(25).fill('x'), series: [{ name: 'S', values: Array(25).fill(1) }] }).success, false)
  assert.equal(BarChart.props.safeParse({ ...chart, series: [{ name: 'S', values: [1, Infinity] }] }).success, false)
  assert.equal(BeTable.props.safeParse({ columns: Array(7).fill('c'), rows: [] }).success, false)
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

test('beUI date range text follows the locale', () => {
  const dates = render('root = BeQuestions("Offsite", [{id: "dates", title: "日期", input: "dateRange"}])', 'zh-CN')
  assert.match(dates, /选择日期/)
  assert.doesNotMatch(dates, /Select dates|Choose a date range/)
})

const reviewTasks = `root = Form("tasks", Buttons([Button("Create these tasks", Action([@ToAssistant("Create these tasks")]), "primary")]), [FormControl("Tasks", EditableTable("tasks", [{type: "text", key: "title", header: "Title"}, {type: "select", key: "priority", header: "Priority", options: [{value: "high", label: "High"}, {value: "low", label: "Low"}]}], [{id: "1", values: ["Write brief", "high"]}, {id: "2", values: ["Review design", "low"]}]))])`

test('OpenUI Tag, Steps and an EditableTable in a Form render for the Coordinator', () => {
  for (const source of ['root = Tag("Done", null, "sm", "success")', 'root = Steps([StepsItem("Kickoff", "Agree on scope.")])', reviewTasks]) {
    const parsed = parser.parse(source)
    assert.deepEqual(parsed.meta.errors, [], source)
    assert.equal(detectAgentUISource(source.replace(/^root = /, '')).isOpenUI, true, source)
  }
  assert.match(render('root = Tag("Done", null, "sm", "success")'), /Done/)
  assert.match(render('root = Steps([StepsItem("Kickoff", "Agree on scope.")])'), /Agree on scope/)
  const review = render(reviewTasks)
  assert.match(review, /Write brief/)
  assert.match(review, /Create these tasks/)
  // OpenUI's own save bar is English-only; ours writes edits into the Form instead.
  assert.doesNotMatch(review, /Save Changes|changes made/)
  const { EditableTable } = agentComponentCatalog
  assert.equal(EditableTable.props.safeParse({ name: 't', columns: Array(7).fill({ type: 'text', key: 'k', header: 'h' }), data: [] }).success, false)
})

test('Text inside an OpenUI card is part of the card, not a chat bubble', () => {
  const html = renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}><ReplyBubbles value>
    <AgentGenerativeUI response={'root = Stack([TextContent("Outside"), Card([TextContent("Inside")])])'} isStreaming={false} onAction={() => {}} />
  </ReplyBubbles></NextIntlClientProvider>)
  assert.equal(html.match(/data-agent-text/g)?.length, 1)
  assert.match(html, /Inside/)
})

test('An OpenUI button or form submit continues the chat with its label and the edited rows', () => {
  const prompt = actionPrompt({ type: 'continue_conversation', params: {}, humanFriendlyMessage: 'Create these tasks', formState: { tasks: { tasks: { value: [{ id: '1', values: ['Write brief', 'high'] }, { id: '2', values: ['Review design', 'low'] }], componentType: 'EditableTable' } } } })
  assert.equal(prompt, 'Create these tasks\n\ntasks\n- Write brief · high\n- Review design · low')
  assert.equal(actionPrompt({ type: 'continue_conversation', params: {}, humanFriendlyMessage: 'Next' }), 'Next')
})

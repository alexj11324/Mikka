'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { AgentApproval, AgentQuestions, useAgentDecision } from './agent-decision'
import { AgentCodeContent, AgentContent, AgentStatusIcon, AgentTasks, AgentTextContent } from './agent-content'
import { AgentImage } from './agent-image'
import { AgentImageCard } from './agent-image-card'
import { CitationChip, WebCitation } from './agent-citations'
import { ComputerCard } from '@/components/computer/computer-card'
import { Button as BeButton } from '@/components/motion/button/base'
import { AnimatedNumber } from '@/components/motion/animated-number'
import { Card as BeCard, CardContent as BeCardContent, CardDescription as BeCardDescription, CardHeader as BeCardHeader, CardTitle as BeCardTitle } from '@/components/motion/card'
import { createAgentLibrary, type AgentComponentRenderers, type LegacyAgentComponentRenderers } from '@/lib/agent-ui-catalog'
import { Badge } from '@/components/ui/badge'
import type { StatusTone } from '@/lib/status-appearance'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { AgentTextBubble, InsideBlock } from './agent-text-bubble'
import { Alert as BeAlert, AlertContent as BeAlertContent, AlertDescription as BeAlertDescription, AlertIcon as BeAlertIcon, AlertTitle as BeAlertTitle } from '@/components/motion/alert'
import { Collapsible as BeCollapsible, CollapsibleContent as BeCollapsibleContent, CollapsibleIndicator as BeCollapsibleIndicator, CollapsibleTrigger as BeCollapsibleTrigger } from '@/components/motion/collapsible'
import { Tabs as BeTabs, TabsContent as BeTabsContent, TabsList as BeTabsList, TabsTrigger as BeTabsTrigger } from '@/components/motion/tabs'
import { AgentAreaChart, AgentBarChart, AgentDonutChart, AgentLineChart, AgentRadialChart } from './agent-chart'
import { AgentCitations, AgentFileDiff, AgentFileTree, AgentTable } from './agent-report'
import { AgentEditableTable } from './agent-editable-table'

const renderers = {
  TextContent: AgentTextContent,
  BeCodeBlock: AgentCodeContent,
  BeCard: ({ props, renderNode }) => <BeCard size="compact" className="min-w-0">
    <BeCardHeader><BeCardTitle as="h3">{props.title}</BeCardTitle>{props.description && <BeCardDescription>{props.description}</BeCardDescription>}</BeCardHeader>
    <BeCardContent className="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</BeCardContent>
  </BeCard>,
  BeCardGrid: ({ props, renderNode }) => <div className="@container/agent-cards w-full min-w-0"><div role="group" aria-label={agentCopy.illustratedRecommendationCards} className="grid min-w-0 grid-cols-1 items-stretch gap-4 @min-[26rem]/agent-cards:grid-cols-2 @min-[44rem]/agent-cards:grid-cols-3">{renderNode(props.children)}</div></div>,
  BeImageCard: ({ props }) => <AgentImageCard {...props} />,
  BeImage: ({ props }) => <AgentImage {...props} />,
  BeButton: function BePromptButton({ props }) {
  const agentCopy = useAgentCopy()

    const { send, sent, error, status } = useAgentDecision()
    return <div className="flex min-w-0 flex-col gap-2">
      <BeButton type="button" variant={props.variant} size="sm" disabled={status !== 'pending'} onClick={() => { void send(props.action) }}>{sent ? agentCopy.asked : props.label === agentCopy.fillQuestion ? agentCopy.askNow : props.label}</BeButton>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
  },
  BeStat: ({ props }) => {
    const formatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: props.precision ?? 0, maximumFractionDigits: props.precision ?? 0 })
    return <BeCard size="compact" className="min-w-0">
      <BeCardHeader><BeCardTitle>{props.label}</BeCardTitle></BeCardHeader>
      <BeCardContent><p className="text-2xl font-semibold">
        <span aria-hidden="true"><AnimatedNumber value={props.value} format={value => formatter.format(value)} />{props.unit}</span>
        <span className="sr-only">{formatter.format(props.value)}{props.unit}</span>
      </p></BeCardContent>
    </BeCard>
  },
  // No suggestion cards in a chat (R-12): saved follow-ups draw nothing; agent-follow-ups.tsx stays in the library.
  BeFollowUps: () => null,
  BeResponse: AgentContent,
  BeApproval: AgentApproval,
  BeQuestions: AgentQuestions,
  BeTodoList: AgentTasks,
  AgentIcon: AgentStatusIcon,
  InlineText: ({ props, renderNode }) => <AgentTextBubble><p className="min-w-0 break-words text-sm leading-7">{renderNode(props.parts)}</p></AgentTextBubble>,
  TaskChip: ({ props }) => <CitationChip id={props.id.toLowerCase()} kind="issue" />,
  RunChip: ({ props }) => <CitationChip id={props.id.toLowerCase()} kind="run" />,
  SourceChip: ({ props }) => <WebCitation url={props.url} label={props.label ?? null} />,
  ComputerCard: ({ props }) => <ComputerCard {...props} />,
  BeAlert: ({ props }) => <BeAlert variant={props.variant} role="status"><BeAlertIcon /><BeAlertContent><BeAlertTitle>{props.title}</BeAlertTitle><BeAlertDescription>{props.description}</BeAlertDescription></BeAlertContent></BeAlert>,
  BeTable: ({ props }) => <AgentTable columns={props.columns} rows={props.rows} />,
  EditableTable: ({ props }) => <AgentEditableTable name={props.name} columns={props.columns} data={props.data} />,
  BeTabs: ({ props, renderNode }) => <BeTabs defaultValue="0" variant="underline" className="min-w-0">
    <BeTabsList>{(props.items ?? []).map((item, index) => <BeTabsTrigger key={index} value={String(index)}>{item.title}</BeTabsTrigger>)}</BeTabsList>
    {(props.items ?? []).map((item, index) => <BeTabsContent key={index} value={String(index)} className="flex min-w-0 flex-col gap-3 pt-3">{renderNode(item.children)}</BeTabsContent>)}
  </BeTabs>,
  BeCollapsible: ({ props, renderNode }) => <BeCollapsible defaultOpen={props.defaultOpen} className="min-w-0">
    <BeCollapsibleTrigger>{props.title}<BeCollapsibleIndicator /></BeCollapsibleTrigger>
    <BeCollapsibleContent contentClassName="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</BeCollapsibleContent>
  </BeCollapsible>,
  BarChart: ({ props }) => <AgentBarChart labels={props.labels} series={props.series} horizontal={props.horizontal} unit={props.unit} />,
  LineChart: ({ props }) => <AgentLineChart labels={props.labels} series={props.series} unit={props.unit} />,
  AreaChart: ({ props }) => <AgentAreaChart labels={props.labels} series={props.series} unit={props.unit} />,
  DonutChart: ({ props }) => <AgentDonutChart slices={props.slices} unit={props.unit} total={props.total} />,
  RadialChart: ({ props }) => <AgentRadialChart label={props.label} used={props.used} limit={props.limit} unit={props.unit} />,
  // UI policy draws no horizontal rules: a section break is space, still announced as a separator.
  Separator: () => <div role="separator" className="h-2" />,
  BeFileTree: ({ props }) => <AgentFileTree paths={props.paths} />,
  BeCitations: ({ props }) => <AgentCitations sources={props.sources} />,
  BeFileDiff: ({ props }) => <AgentFileDiff file={props.file} diff={props.diff} language={props.language} />,
} satisfies AgentComponentRenderers

// Saved replies' retired components, drawn as the component that replaced each (lib/agent-ui-catalog.ts).
const TONES: Record<string, StatusTone> = { destructive: 'destructive', 'destructive-light': 'destructive', danger: 'destructive', 'success-light': 'success', success: 'success', 'warning-light': 'warning', warning: 'warning', 'info-light': 'info', info: 'info', 'primary-light': 'info' }
const LegacyBadge = ({ text, tone }: { text: string; tone?: string }) => <Badge tone={TONES[tone ?? ''] ?? 'neutral'}>{text}</Badge>
const legacyRenderers = {
  ShadcnCard: input => <renderers.BeCard {...input} />,
  ReuiFrame: input => <renderers.BeCard {...input} />,
  ShadcnBadge: ({ props }) => <LegacyBadge text={props.text} tone={props.variant} />,
  ReuiBadge: ({ props }) => <LegacyBadge text={props.text} tone={props.variant} />,
  BeBadge: ({ props }) => <LegacyBadge text={props.text} tone={props.status} />,
  ShadcnAlert: input => <renderers.BeAlert {...input} />,
  ReuiAlert: input => <renderers.BeAlert {...input} />,
  ShadcnProgress: ({ props }) => <AgentRadialChart label={props.label} used={props.value} limit={100} unit="%" />,
  ShadcnAccordion: ({ props }) => <div className="flex min-w-0 flex-col gap-1">
    {(props.items ?? []).map((item, index) => <BeCollapsible key={index} className="min-w-0">
      <BeCollapsibleTrigger>{item.title}<BeCollapsibleIndicator /></BeCollapsibleTrigger>
      <BeCollapsibleContent><p className="text-sm leading-6">{item.content}</p></BeCollapsibleContent>
    </BeCollapsible>)}
  </div>,
  ShadcnTabs: input => <renderers.BeTabs {...input} />,
  ShadcnTable: ({ props }) => <AgentTable columns={props.columns} rows={props.rows} />,
  ShadcnButton: ({ props, ...input }) => <renderers.BeButton {...input} props={{ label: props.label, action: props.prompt, variant: props.variant === 'default' ? 'primary' : props.variant }} />,
  BeTimeline: ({ props, ...input }) => <renderers.TextContent {...input} props={{ text: (props.events ?? []).map(event => `- **${event.date} · ${event.title}**${event.description ? `：${event.description}` : ''}`).join('\n') }} />,
} satisfies LegacyAgentComponentRenderers

// Replies flow through these; every other component, ours or OpenUI's, is a block, and text inside it gets no bubble.
const FLOW = new Set<string>(['Stack', 'TextContent', 'InlineText', 'BeResponse', 'TaskChip', 'RunChip', 'SourceChip'])
const block = <Render,>(name: string, render: Render): Render => FLOW.has(name) ? render
  : ((input: object) => { const Block = render as (props: object) => React.ReactNode; return <InsideBlock value><Block {...input} /></InsideBlock> }) as Render
const blocks = Object.fromEntries(Object.entries({ ...renderers, ...legacyRenderers }).map(([name, render]) => [name, block(name, render)])) as typeof renderers & typeof legacyRenderers

export const agentUILibrary = createAgentLibrary(blocks, block)

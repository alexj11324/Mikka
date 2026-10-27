'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import { Info } from 'lucide-react'
import { AgentApproval, AgentQuestions, useAgentDecision } from './agent-decision'
import { AgentCodeContent, AgentContent, AgentStatusIcon, AgentTasks, AgentTextContent } from './agent-content'
import { AgentImage } from './agent-image'
import { AgentFollowUps } from './agent-follow-ups'
import { AgentImageCard } from './agent-image-card'
import { CitationChip, WebCitation } from './agent-citations'
import { ComputerCard } from '@/components/computer/computer-card'
import { Button as BeButton } from '@/components/motion/button/base'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { AnimatedNumber } from '@/components/motion/animated-number'
import { Card as BeCard, CardContent as BeCardContent, CardDescription as BeCardDescription, CardHeader as BeCardHeader, CardTitle as BeCardTitle } from '@/components/motion/card'
import { createAgentLibrary, type AgentComponentRenderers } from '@/lib/agent-ui-catalog'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert as ReuiAlert, AlertDescription as ReuiAlertDescription, AlertTitle as ReuiAlertTitle } from '@/components/reui/alert'
import { Badge as ReuiBadge } from '@/components/reui/badge'
import { AgentTextBubble, InsideBlock } from './agent-text-bubble'
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from '@/components/reui/frame'

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
  BeBadge: ({ props }) => <AnimatedBadge status={props.status} size="sm" pulse={false}>{props.text}</AnimatedBadge>,
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
  BeFollowUps: AgentFollowUps,
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
  ShadcnCard: ({ props, renderNode }) => <Card size="sm" className="min-w-0">
    <CardHeader><CardTitle>{props.title}</CardTitle>{props.description && <CardDescription>{props.description}</CardDescription>}</CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</CardContent>
  </Card>,
  ShadcnBadge: ({ props }) => <Badge variant={props.variant}>{props.text}</Badge>,
  ShadcnAlert: ({ props }) => <Alert variant={props.variant} role="note"><Info aria-hidden="true" /><AlertTitle>{props.title}</AlertTitle><AlertDescription>{props.description}</AlertDescription></Alert>,
  ShadcnProgress: ({ props }) => <Progress value={props.value}><ProgressLabel>{props.label}</ProgressLabel><ProgressValue /></Progress>,
  ShadcnAccordion: ({ props }) => <Accordion multiple={props.multiple}>
    {(props.items ?? []).map((item, index) => <AccordionItem key={index} value={String(index)}><AccordionTrigger>{item.title}</AccordionTrigger><AccordionContent>{item.content}</AccordionContent></AccordionItem>)}
  </Accordion>,
  ShadcnTabs: ({ props, renderNode }) => <Tabs defaultValue="0" className="min-w-0">
    <TabsList className="max-w-full overflow-x-auto">{(props.items ?? []).map((item, index) => <TabsTrigger key={index} value={String(index)}>{item.title}</TabsTrigger>)}</TabsList>
    {(props.items ?? []).map((item, index) => <TabsContent key={index} value={String(index)} className="flex min-w-0 flex-col gap-3">{renderNode(item.children)}</TabsContent>)}
  </Tabs>,
  ShadcnTable: ({ props }) => <Table>
    <TableHeader><TableRow>{(props.columns ?? []).map((column, index) => <TableHead key={index}>{column}</TableHead>)}</TableRow></TableHeader>
    <TableBody>{(props.rows ?? []).map((row, index) => <TableRow key={index}>{(row ?? []).map((cell, cellIndex) => <TableCell key={cellIndex}>{cell}</TableCell>)}</TableRow>)}</TableBody>
  </Table>,
  ShadcnButton: function PromptButton({ props }) {
  const agentCopy = useAgentCopy()

    const { send, sent, error, status } = useAgentDecision()
    return <div className="flex min-w-0 flex-col gap-2">
      <Button type="button" variant={props.variant} disabled={status !== 'pending'} onClick={() => { void send(props.prompt) }}>{sent ? agentCopy.asked : props.label === agentCopy.fillQuestion ? agentCopy.askNow : props.label}</Button>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
  },
  ReuiBadge: ({ props }) => <ReuiBadge variant={props.variant ?? 'outline'}>{props.text}</ReuiBadge>,
  ReuiAlert: ({ props }) => <ReuiAlert variant={props.variant} role="note"><Info aria-hidden="true" /><ReuiAlertTitle>{props.title}</ReuiAlertTitle><ReuiAlertDescription>{props.description}</ReuiAlertDescription></ReuiAlert>,
  ReuiFrame: ({ props, renderNode }) => <Frame spacing="sm" className="min-w-0">
    <FrameHeader><FrameTitle>{props.title}</FrameTitle>{props.description && <FrameDescription>{props.description}</FrameDescription>}</FrameHeader>
    <FramePanel className="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</FramePanel>
  </Frame>,
} satisfies AgentComponentRenderers

// Replies flow through these; every other component is a block, and text inside it gets no bubble.
const FLOW = new Set<string>(['TextContent', 'InlineText', 'BeResponse', 'TaskChip', 'RunChip', 'SourceChip'])
const blocks = Object.fromEntries(Object.entries(renderers).map(([name, Render]) => [name, FLOW.has(name) ? Render
  : (input: object) => { const Block = Render as (props: object) => React.ReactNode; return <InsideBlock value><Block {...input} /></InsideBlock> }])) as typeof renderers

export const agentUILibrary = createAgentLibrary(blocks)

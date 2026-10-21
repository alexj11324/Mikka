'use client'

import { useIsStreaming, useTriggerAction } from '@openuidev/react-lang'
import { Info } from 'lucide-react'
import { AgentApproval, AgentQuestions } from './agent-decision'
import { AgentContent, AgentStatusIcon, AgentTasks } from './agent-content'
import { Button as BeButton } from '@/components/motion/button/base'
import { AnimatedBadge } from '@/components/motion/animated-badge'
import { AnimatedNumber } from '@/components/motion/animated-number'
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
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from '@/components/reui/frame'

const renderers = {
  BeButton: function BePromptButton({ props }) {
    const trigger = useTriggerAction()
    const streaming = useIsStreaming()
    return <BeButton type="button" variant={props.variant} size="sm" disabled={streaming} onClick={() => trigger(props.action)}>{props.label}</BeButton>
  },
  BeBadge: ({ props }) => <AnimatedBadge status={props.status} size="sm" pulse={false}>{props.text}</AnimatedBadge>,
  BeStat: ({ props }) => {
    const formatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: props.precision ?? 0, maximumFractionDigits: props.precision ?? 0 })
    return <Card size="sm" className="min-w-0">
      <CardHeader><CardTitle>{props.label}</CardTitle></CardHeader>
      <CardContent><p className="text-2xl font-semibold">
        <span aria-hidden="true"><AnimatedNumber value={props.value} format={value => formatter.format(value)} />{props.unit}</span>
        <span className="sr-only">{formatter.format(props.value)}{props.unit}</span>
      </p></CardContent>
    </Card>
  },
  BeResponse: AgentContent,
  BeApproval: AgentApproval,
  BeQuestions: AgentQuestions,
  BeTodoList: AgentTasks,
  AgentIcon: AgentStatusIcon,
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
    const trigger = useTriggerAction()
    const streaming = useIsStreaming()
    return <Button type="button" variant={props.variant} disabled={streaming} onClick={() => trigger(props.label, undefined, { type: 'continue_conversation', params: { context: props.prompt } })}>{props.label}</Button>
  },
  ReuiBadge: ({ props }) => <ReuiBadge variant={props.variant ?? 'outline'}>{props.text}</ReuiBadge>,
  ReuiAlert: ({ props }) => <ReuiAlert variant={props.variant} role="note"><Info aria-hidden="true" /><ReuiAlertTitle>{props.title}</ReuiAlertTitle><ReuiAlertDescription>{props.description}</ReuiAlertDescription></ReuiAlert>,
  ReuiFrame: ({ props, renderNode }) => <Frame spacing="sm" className="min-w-0">
    <FrameHeader><FrameTitle>{props.title}</FrameTitle>{props.description && <FrameDescription>{props.description}</FrameDescription>}</FrameHeader>
    <FramePanel className="flex min-w-0 flex-col gap-3">{renderNode(props.children)}</FramePanel>
  </Frame>,
} satisfies AgentComponentRenderers

export const agentUILibrary = createAgentLibrary(renderers)

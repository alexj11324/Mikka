'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { AgentComponentRenderers } from '@/lib/agent-ui-catalog'
import { useAgentDecision } from './agent-decision'

function FollowUp({ label, prompt }: { label: string; prompt: string }) {
  const agentCopy = useAgentCopy()

  const { send, sent, error, status } = useAgentDecision()
  return <div className="flex min-w-0 flex-col gap-2">
    <Button type="button" variant="outline" disabled={status !== 'pending'} className="h-auto justify-between gap-3 whitespace-normal py-3 text-left" onClick={() => { void send(prompt) }}>
      <span>{label}{sent && <span className="sr-only">{agentCopy.asked2}</span>}</span><ArrowUpRight aria-hidden="true" data-icon="inline-end" />
    </Button>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  </div>
}

export const AgentFollowUps: AgentComponentRenderers['BeFollowUps'] = ({ props }) => { const agentCopy = useAgentCopy(); return (<section aria-label={agentCopy.relatedQuestions} className="flex min-w-0 flex-col gap-2">
  <p className="text-sm text-muted-foreground">{agentCopy.youMayAlsoWantToAsk}</p>
  {(props.items ?? []).map(item => <FollowUp key={item.label} {...item} />)}
</section>) }

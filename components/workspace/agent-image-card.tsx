'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { AgentImage } from './agent-image'
import { useAgentDecision } from './agent-decision'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/motion/card'

export function AgentImageCard({ title, query, description, tags = [], prompt }: {
  title: string
  query: string
  description: string
  tags?: string[]
  prompt?: string
}) {
  const agentCopy = useAgentCopy()

  const { send, sent, error, status } = useAgentDecision()
  return <Card size="compact" className="h-full min-w-0" role="group" aria-label={title}>
    <CardContent><AgentImage query={query} alt={title} compact /></CardContent>
    <CardHeader>
      <CardTitle as="h3">{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
    {tags.length > 0 && <CardContent className="flex flex-wrap gap-1.5">{tags.map((tag, index) => <Badge key={index} variant="secondary">{tag}</Badge>)}</CardContent>}
    {prompt && <CardFooter className="mt-auto flex-col items-start gap-2">
      <Button type="button" variant="outline" size="sm" disabled={status !== 'pending'} onClick={() => { void send(prompt) }}>{sent ? agentCopy.asked : agentCopy.learnMore}</Button>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </CardFooter>}
  </Card>
}

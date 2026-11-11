'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { openInteractions } from 'eve/events'
import { parseAnswers } from 'eve/client'
import type { Interaction, UseEveAgentReturn } from 'eve/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemTitle } from '@/components/ui/item'
import { useActionError } from '@/lib/use-action-error'

/** Interaction state and answered/withdrawn reconciliation belong to eve's session view. */
function EveInteraction({ interaction, respond, resuming }: { interaction: Interaction; respond: UseEveAgentReturn['respond']; resuming: boolean }) {
  const t = useTranslations('Coordinator.eve')
  const actionError = useActionError()
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const request = interaction.request
  async function answer(value: { optionId?: string; text?: string }) {
    if (pending || resuming || interaction.answer) return
    setPending(true); setError(false)
    try { await respond(parseAnswers([{ interactionId: interaction.interactionId, ...value }])) }
    catch { setError(true) }
    finally { setPending(false) }
  }
  const link = request.signIn?.url ?? request.link?.url
  // These URLs are server-authored sign-in targets; reject executable schemes at the UI boundary.
  const href = link && /^https?:\/\//i.test(link) ? link : undefined
  return <Item variant="muted" data-eve-interaction={interaction.interactionId}>
    <ItemContent>
      <ItemTitle>{request.prompt}</ItemTitle>
      {request.allowFreeform && <form onSubmit={event => { event.preventDefault(); if (text.trim()) void answer({ text: text.trim() }) }} className="flex gap-2">
        <Input value={text} onChange={event => setText(event.target.value)} aria-label={request.prompt} disabled={pending || resuming || Boolean(interaction.answer)} />
        <Button type="submit" size="sm" disabled={pending || resuming || !text.trim() || Boolean(interaction.answer)}>{t('submit')}</Button>
      </form>}
      {error && <span role="alert">{actionError()}</span>}
    </ItemContent>
    <ItemActions>
      {request.options?.map(option => <Button key={option.id} type="button" size="sm" variant={option.style === 'danger' ? 'destructive' : 'outline'} disabled={pending || resuming || Boolean(interaction.answer)} onClick={() => void answer({ optionId: option.id })}>{option.label}</Button>)}
      {href && <Button size="sm" variant="outline" render={<a href={href} target="_blank" rel="noopener noreferrer" />}>{request.link?.label ?? request.signIn?.displayName ?? t('open')}</Button>}
    </ItemActions>
  </Item>
}

export function EveInteractions({ agent }: { agent: Pick<UseEveAgentReturn, 'view' | 'respond' | 'status'> }) {
  return openInteractions(agent.view).map(interaction => <EveInteraction key={interaction.interactionId} interaction={interaction} respond={agent.respond} resuming={agent.status === 'resuming'} />)
}

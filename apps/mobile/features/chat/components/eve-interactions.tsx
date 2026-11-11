import { useState } from 'react'
import { Linking } from 'react-native'
import { openInteractions } from 'eve/events'
import { parseAnswers } from 'eve/client'
import type { UseEveAgentReturn, Interaction } from 'eve/react'
import { CardButton, ChatCard, cardText } from '@/components/cards'
import { Text } from '@/components/Text'
import { mobileMessages } from '@/lib/messages'

function Request({ item, respond, resuming }: { item: Interaction; respond: UseEveAgentReturn['respond']; resuming: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const request = item.request
  const link = request.signIn?.url ?? request.link?.url
  async function choose(optionId: string) {
    if (pending || resuming || item.answer) return
    setPending(true); setError(false)
    try { await respond(parseAnswers([{ interactionId: item.interactionId, optionId }])) }
    catch { setError(true) }
    finally { setPending(false) }
  }
  return <ChatCard>
    <Text style={cardText.title}>{request.prompt}</Text>
    {request.options?.map(option => <CardButton key={option.id} label={option.label} disabled={resuming || Boolean(item.answer)} busy={pending} destructive={option.style === 'danger'} onPress={() => void choose(option.id)} />)}
    {link && /^https?:\/\//i.test(link) ? <CardButton label={request.link?.label ?? request.signIn?.displayName ?? mobileMessages.Coordinator.eve.open} onPress={() => { void Linking.openURL(link) }} /> : null}
    {error ? <Text accessibilityRole="alert" style={cardText.error}>{mobileMessages.Coordinator.sendUncertain}</Text> : null}
  </ChatCard>
}

/** eve is the authoritative state for approvals, questions and sign-ins on every client. */
export function EveInteractions({ agent }: { agent: Pick<UseEveAgentReturn, 'view' | 'respond' | 'status'> }) {
  return openInteractions(agent.view).map(item => <Request key={item.interactionId} item={item} respond={agent.respond} resuming={agent.status === 'resuming'} />)
}

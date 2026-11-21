import { useReducer, useState } from 'react'
import { createDecisionSubmission } from '../../../../../hooks/decision-submission'
import { Linking } from 'react-native'
import { openInteractions } from 'eve/events'
import { parseAnswers } from 'eve/client'
import type { UseEveAgentReturn, Interaction } from 'eve/react'
import { CardButton, ChatCard, cardText } from '@/components/cards'
import { Text } from '@/components/Text'
import { Input } from '@/components/beui/components/input'
import { mobileMessages } from '@/lib/messages'

function Request({ item, respond, resuming }: { item: Interaction; respond: UseEveAgentReturn['respond']; resuming: boolean }) {
  const [draft, setDraft] = useState('')
  const [, update] = useReducer((value: number) => value + 1, 0)
  const [operation] = useState(() => createDecisionSubmission(update))
  const result = operation.state(item.interactionId)
  const pending = result.status === 'submitting'
  const disabled = resuming || Boolean(item.answer) || pending || result.status === 'accepted'
  const request = item.request
  const link = request.signIn?.url ?? request.link?.url
  function answer(value: { optionId: string } | { text: string }) {
    if (disabled) return
    void operation.submit(item.interactionId, async () => {
      try {
        await respond(parseAnswers([{ interactionId: item.interactionId, ...value }]))
        return { status: 'accepted' }
      } catch (failure) {
        const status = (failure as { status?: number } | null)?.status
        if (status === 429) return { status: 'failed', error: mobileMessages.Coordinator.sendRateLimited }
        if (status === 401 || status === 403 || status === 404) return { status: 'failed', error: mobileMessages.Coordinator.sendAccessDenied }
        return { status: 'uncertain', error: mobileMessages.Coordinator.sendUncertain }
      }
    }, mobileMessages.Coordinator.sendUncertain)
  }
  function sendDraft() {
    const text = draft.trim()
    if (text) answer({ text })
  }
  return <ChatCard>
    <Text style={cardText.title}>{request.prompt}</Text>
    {request.allowFreeform && <>
      <Input accessibilityLabel={request.prompt} value={draft} onChangeText={setDraft} disabled={disabled}
        returnKeyType="send" submitBehavior="submit" onSubmitEditing={sendDraft} />
      <CardButton primary label={mobileMessages.Coordinator.eve.submit} disabled={disabled || !draft.trim()} busy={pending} onPress={sendDraft} />
    </>}
    {request.options?.map(option => <CardButton key={option.id} label={option.label} disabled={disabled} busy={pending} destructive={option.style === 'danger'} onPress={() => answer({ optionId: option.id })} />)}
    {link && /^https?:\/\//i.test(link) ? <CardButton label={request.link?.label ?? request.signIn?.displayName ?? mobileMessages.Coordinator.eve.open} onPress={() => { void Linking.openURL(link) }} /> : null}
    {'error' in result ? <Text accessibilityRole="alert" style={cardText.error}>{result.error}</Text> : null}
  </ChatCard>
}

/** eve is the authoritative state for approvals, questions and sign-ins on every client. */
export function EveInteractions({ agent }: { agent: Pick<UseEveAgentReturn, 'view' | 'respond' | 'status'> }) {
  return openInteractions(agent.view).map(item => <Request key={item.interactionId} item={item} respond={agent.respond} resuming={agent.status === 'resuming'} />)
}

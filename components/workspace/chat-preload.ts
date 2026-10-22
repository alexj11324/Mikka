let agent: Promise<typeof import('./agent-panel')> | undefined
let coordinator: Promise<typeof import('@/components/coordinator/coordinator-chat')> | undefined

export function loadAgentPanel() {
  agent ??= import('./agent-panel').catch(error => { agent = undefined; throw error })
  return agent
}

export function loadCoordinatorChat() {
  coordinator ??= import('@/components/coordinator/coordinator-chat').catch(error => { coordinator = undefined; throw error })
  return coordinator
}

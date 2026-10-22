let agent: Promise<typeof import('./agent-panel')> | undefined

export function loadAgentPanel() {
  agent ??= import('./agent-panel').catch(error => { agent = undefined; throw error })
  return agent
}

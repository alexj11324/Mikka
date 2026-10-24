import { withBasePath } from '@/lib/base-path'
import { MOCK_HOSTS, mockComputer, mockSetup } from './mock'
import type { ApprovalDecision, ApprovalView, ComputerEvent, ComputerState, KnownHost, SetupStep, SetupStepState, ViewerGrant, ViewerMode } from './types'

/** The backend is still being built (#172); this flag plays it in the page instead. */
export const computerMock = process.env.NEXT_PUBLIC_COMPUTER_MOCK === '1'
/** The component library's demo bots (ids start with "demo-") always play the mock. */
export const isMockedComputer = (agentId: string) => computerMock || agentId.startsWith('demo-')

export class ComputerRequestError extends Error {
  constructor(readonly status: number, readonly body: unknown) { super(`HTTP ${status}`) }
}

async function call<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const response = await fetch(withBasePath(path), {
    credentials: 'same-origin',
    ...init,
    headers: init?.json === undefined ? init?.headers : { 'content-type': 'application/json', ...init.headers },
    body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
  })
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new ComputerRequestError(response.status, body)
  return body as T
}

const agentPath = (agentId: string, rest = '') => `/api/agents/${encodeURIComponent(agentId)}/computer${rest}`

export const computerApi = {
  state: (agentId: string) => isMockedComputer(agentId) ? mockComputer.state(agentId) : call<ComputerState>(agentPath(agentId)),
  wake: (agentId: string) => isMockedComputer(agentId) ? mockComputer.wake(agentId) : call<null>(agentPath(agentId, '/wake'), { method: 'POST' }),
  viewer: (agentId: string, mode: ViewerMode) => isMockedComputer(agentId) ? mockComputer.viewer(agentId, mode) : call<ViewerGrant>(agentPath(agentId, '/viewer'), { method: 'POST', json: { mode } }),
  takeover: (agentId: string, userId: string) => isMockedComputer(agentId) ? mockComputer.takeover(agentId, userId) : call<ViewerGrant>(agentPath(agentId, '/takeover'), { method: 'POST' }),
  handback: (agentId: string) => isMockedComputer(agentId) ? mockComputer.handback(agentId) : call<null>(agentPath(agentId, '/handback'), { method: 'POST' }),
  /** Answers "queued", never an invented success: the agent goes on when the daemon picks it up. */
  decide: (approval: ApprovalView, decision: ApprovalDecision) => isMockedComputer(approval.agentId)
    ? mockComputer.decide(approval, decision)
    : call<{ queued: true }>(`/api/computer/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', json: decision }),
}

/**
 * Workspace-wide pushes. Until GET /api/computer/events exists the stream
 * fails once and closes; callers keep polling every 2s, which the contract
 * allows as the first step.
 */
export function subscribeComputerEvents(listener: (event: ComputerEvent) => void, mocked = computerMock): () => void {
  if (mocked) return mockComputer.subscribe(listener)
  if (typeof EventSource === 'undefined') return () => {}
  const source = new EventSource(withBasePath('/api/computer/events'), { withCredentials: true })
  const types: ComputerEvent['type'][] = ['computer.machine', 'computer.control', 'computer.action', 'computer.approval']
  for (const type of types) source.addEventListener(type, message => {
    try { listener({ type, ...JSON.parse((message as MessageEvent<string>).data) } as ComputerEvent) } catch { /* a malformed push; the next poll corrects it */ }
  })
  source.onerror = () => { if (source.readyState === EventSource.CLOSED) source.close() }
  return () => source.close()
}

/**
 * Hosts from the user's ~/.ssh/config and Tailnet, which their own Mikka
 * reports. Without one the list is empty and the user types a host.
 */
export async function listKnownHosts(fallback: () => Promise<KnownHost[]>): Promise<KnownHost[]> {
  if (computerMock) return MOCK_HOSTS
  try { return await call<KnownHost[]>('/api/devices/hosts') } catch (error) {
    if (error instanceof ComputerRequestError && error.status === 404) return fallback()
    throw error
  }
}

/** Runs the SSH install and reports each of 登录 → 检查主机 → 安装 Mikka → 启动服务 → 连接. */
export async function setUpHost(input: { host: string; user: string; locale: string }, onStep: (step: SetupStep, state: SetupStepState, detail?: string) => void, signal: AbortSignal) {
  if (computerMock) return mockSetup(onStep, signal)
  const response = await fetch(withBasePath('/api/devices/ssh'), {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host: input.host, user: input.user, name: '', locale: input.locale }), signal,
  })
  if (!response.ok || !response.body) throw new ComputerRequestError(response.status, null)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as { step: SetupStep; state: SetupStepState; detail?: string }
        onStep(event.step, event.state, event.detail)
      } catch { /* a partial line; the next chunk completes it */ }
    }
  }
}

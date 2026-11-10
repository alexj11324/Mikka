/** Real shared MCP metadata and handlers. Preparation does not authorize a call. */
export interface MikkaMcpTool {
  name: string
  inputSchema: Record<string, unknown>
  [key: string]: unknown
}
export interface MikkaMcpRequest {
  jsonrpc?: string
  id: string | number
  method: string
  params?: Record<string, unknown>
}
export interface MikkaMcpResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}
export interface MikkaMcpContext {
  handoffFile: string
  capturesDir?: string | null
  captureRoots?: string[]
  repositoryRoot?: string | null
  artifactRoot?: string | null
  factoryVerify?: Record<string, unknown> | null
  toolIsolation?: import('./native-tool-isolation.mjs').NativeToolIsolationConfig | null
  decisionUrl?: string
  decisionToken?: string
  decisionCatalogue?: string
  /** Host-bound telemetry only; never task authority or tool input. */
  decisionTraceparent?: string
  observationUrl?: string
  env?: Record<string, string | undefined>
}
export interface MikkaMcpProfile {
  decisionCatalogue?: string
  repositorySelection?: boolean
  captures?: boolean
  factoryVerify?: boolean
  artifactInspection?: boolean
  nativeToolIsolation?: boolean
}
export interface MikkaMcpAuthority {
  signal: AbortSignal
  /** Synchronous, local-only check of the bound task's existing authority. */
  assertLive(): void
}
interface MikkaMcpHandler {
  handle(message: MikkaMcpRequest): Promise<MikkaMcpResponse>
  handle(message: Partial<MikkaMcpRequest>): Promise<MikkaMcpResponse | undefined>
}
export interface MikkaMcpBackend extends MikkaMcpHandler {
  tools(): Promise<MikkaMcpTool[]>
  /** EOF drains accepted calls; cancellation also aborts pending HTTP. */
  close(options?: { abort?: boolean }): Promise<void>
}
export interface PreparedMikkaMcpBackend extends MikkaMcpHandler {
  tools(): MikkaMcpTool[]
  /** Consumed once, including failure. No task call is admitted until this resolves. */
  bind(context: MikkaMcpContext, authority: MikkaMcpAuthority): Promise<void>
  close(): Promise<void>
}
export function createMikkaMcpBackend(
  context: MikkaMcpContext,
  options?: { signal?: AbortSignal; assertLive?: () => void },
): MikkaMcpBackend
export function mikkaMcpToolCatalogue(profile?: MikkaMcpProfile): MikkaMcpTool[]
export function prepareMikkaMcpBackend(profile?: MikkaMcpProfile): PreparedMikkaMcpBackend

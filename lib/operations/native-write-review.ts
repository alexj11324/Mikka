/** Host capability only. It is never accepted in model/tool input. */
export interface NativeWriteBinding {
  ownerId: string
  botId: string | null
  action: string
  input: unknown
  accountId: string | null
  version: string
  context?: unknown
  policy?: unknown
}
export type NativeWriteDecision = 'allow' | 'ask' | 'deny'
export type NativeWriteReview = (decision: NativeWriteDecision, binding: NativeWriteBinding) => Promise<NativeWriteDecision>

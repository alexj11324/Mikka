import { z } from 'zod'
import { CodedError, type CodedErrorOptions } from './coded-error'

export const TERMINAL_INPUT_BYTES = 16_384
export const TERMINAL_SESSION_SECONDS = 300
export const terminalInputSchema = z.object({
  data: z.string().max(TERMINAL_INPUT_BYTES).refine(value => new TextEncoder().encode(value).byteLength <= TERMINAL_INPUT_BYTES),
  /** Optional for native/API clients. The shipped hook sends only data and
   * never automatically retries input. Reusing an ID cannot execute twice. */
  requestId: z.uuid().optional(),
}).strict()
export const terminalResizeSchema = z.object({ cols: z.number().int().min(2).max(512), rows: z.number().int().min(2).max(256) }).strict()
export const terminalEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('output'), text: z.string() }),
  z.object({ type: z.literal('ended'), exitCode: z.number().int().nullable() }),
])
export type TerminalInput = z.infer<typeof terminalInputSchema>
export type TerminalResize = z.infer<typeof terminalResizeSchema>

export const TERMINAL_STATUS = {
  terminal_unsupported: 404,
  terminal_already_controlled: 423,
  terminal_binding_changed: 409,
  terminal_ended: 409,
  terminal_input_too_large: 413,
  terminal_invalid_request: 400,
  terminal_request_conflict: 409,
  terminal_input_uncertain: 409,
  terminal_limit: 429,
  terminal_unavailable: 503,
} as const
export type TerminalCode = keyof typeof TERMINAL_STATUS
export class TerminalError extends CodedError<TerminalCode> {
  readonly status: number
  constructor(code: TerminalCode, options: CodedErrorOptions = {}) {
    super(code, options)
    this.status = TERMINAL_STATUS[code]
  }
}

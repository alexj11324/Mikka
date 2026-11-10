// Temporary diagnosis only; these IDs confer no authorization or freshness.
export type ReadDiagnosticDump = {
  version: 1; realm: [number, number]; timeOrigin: number; dump: number; reason: number;
  through: number; recorded: number; dropped: number; overflow: boolean; rows: number[][];
}
export const DIAGNOSTIC_PREFIX: string
export const DIAGNOSTIC_LIMIT: number
export const DIAGNOSTIC_ACTIONS: readonly string[]
export const DIAGNOSTIC_KINDS: readonly string[]
export const DE: Readonly<Record<'realm' | 'readBegin' | 'pendingCapture' | 'pendingNotify' | 'pendingRevoke' | 'proof' | 'readReceive' | 'readSettle' | 'readAccept' | 'action' | 'enqueue' | 'dispatch' | 'dispatchAction' | 'response' | 'fresh' | 'channel' | 'subscription' | 'invalidate' | 'flush' | 'scopeReset' | 'incoming', number>>
export function diagRecord(event: number, ...values: number[]): void
export function diagObject(value: unknown): number
export function diagKey(value: string): number
export function diagNext(): number
export function diagCurrentRead(): number
export function diagWithRead<T>(read: number, run: () => T): T
export function diagAction(name: string): number
export function diagActionCode(name: string): number
export function diagKindCode(name: string | undefined): number
export function validateReadDiagnosticDump(value: unknown): value is ReadDiagnosticDump
export function createReadDiagnostic(options: { now(): number; timeOrigin: number; realm: number[]; limit?: number }): {
  record(event: number, ...values: number[]): void; object(value: unknown): number; key(value: string): number;
  next(): number; withRead<T>(read: number, run: () => T): T; current(): number; action(name: string): number; dump(reason: number): ReadDiagnosticDump;
}

export function validateReadDiagnosticRow(value: unknown): boolean

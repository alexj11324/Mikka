import type { ReadDiagnosticDump } from './issue1512-native-reads.mjs'
export type RawReadDiagnostics = { version: 1; expectedDocuments: number; invalidDumps: number; droppedDumps: number; dumps: ReadDiagnosticDump[] }
export function createReadDiagnosticCollector(): {
  document(): void; accept(dump: unknown): boolean; consoleMessage(message: unknown): boolean;
  invalid(): void; snapshot(): RawReadDiagnostics;
}
export function installMainReadDiagnostic(contents: object): void
export function reviewReadDiagnosticCollection(raw: unknown, current: unknown): {
  version: 1; status: 'complete' | 'incomplete'; reasons: number[]; expectedDocuments: number;
  realms: { realm: number[]; timeOrigin: number; dumps: number; recorded: number; through: number; dropped: number; lastSeq: number; lastTime: number; rows: number[][]; current: boolean }[];
}

export function validateReadDiagnosticCollection(value: unknown): value is RawReadDiagnostics

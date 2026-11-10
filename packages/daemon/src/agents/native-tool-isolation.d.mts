export interface NativeToolIsolationConfig {
  binary: string
  worktree: string
  control: string
  home: string
  temp: string
  privateRoots?: string[]
  readRoots?: string[]
  readOnly?: boolean
  taskEnv?: Record<string, string>
}
export const NATIVE_TOOL_PROFILE: 'mikka_tools_v1'
export function nativeRunToolConfig(input: { binary: string; worktree: string; runDir: string; readRoots?: string[]; privateRoots?: string[]; readOnly?: boolean; taskEnv?: Record<string, string> }): NativeToolIsolationConfig
export function nativeToolEnvironment(config: NativeToolIsolationConfig, inherited?: NodeJS.ProcessEnv): Record<string, string>
export function nativeToolToml(value: unknown): string
export function nativeToolFilesystem(config: NativeToolIsolationConfig): Record<string, 'read' | 'write' | 'deny'>
export function nativeToolConfigArgs(config: NativeToolIsolationConfig, inherited?: NodeJS.ProcessEnv): string[]
export function prepareNativeToolDirectories(config: NativeToolIsolationConfig): void
export function nativeControllerCommand(config: NativeToolIsolationConfig, argv: string[], options?: { hideProjectConfig?: boolean }): string[]
export function probeNativeToolIsolation(binary: string | undefined): Promise<boolean>
export function runNativeToolCommand(config: NativeToolIsolationConfig, command: string, options?: {
  signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; inherited?: NodeJS.ProcessEnv; onStdout?: (chunk: string) => void
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; overflow: boolean }>

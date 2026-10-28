import type { Pool, PoolClient } from 'pg'

export interface TestDatabaseTarget {
  host: string
  port: number
  name: string
  schema: 'public'
  user: string
}
export interface TestEnvironment {
  version: 1
  id: string
  kind: 'isolated-ci' | 'isolated-preview'
  origin: string
  basePath: '/mikka'
  deploymentSha: string
  database: TestDatabaseTarget
  instanceId: string
  capabilities: { provision: boolean; mail: 'disabled'; reset: boolean }
}
export class EnvironmentError extends Error {
  code: string
  constructor(code: string)
}
export function databaseTarget(connectionString: string | undefined): TestDatabaseTarget
export function bindingValue(value: TestEnvironment): TestEnvironment
export function environmentFingerprint(value: TestEnvironment): string
export function validateEnvironment(value: unknown, env?: Record<string, string | undefined>): TestEnvironment
export function loadEnvironment(env?: Record<string, string | undefined>): Promise<TestEnvironment>
export function assertDatabaseIdentity(client: Pool | PoolClient, descriptor: TestEnvironment): Promise<void>
export function readIdentityMaterial(client: Pool | PoolClient, descriptor: TestEnvironment): Promise<string>
export function deploymentAttestation(descriptor: TestEnvironment, challenge: string, key: string): string
export function assertDeploymentIdentity(descriptor: TestEnvironment, fetchImpl?: typeof fetch): Promise<{
  environmentId: string
  deploymentSha: string
  origin: string
  fingerprint: string
}>

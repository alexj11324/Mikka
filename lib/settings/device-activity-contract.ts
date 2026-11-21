import type { HarnessInfo } from '@mikka/protocol/harness'

/** Public settings projections. No credential, patch or provider session is returned. */
export interface DeviceSettingsDetail {
  workspaceId: string
  device: {
    id: string
    name: string
    description: string | null
    kind: 'local' | 'cloud'
    deviceType: 'laptop' | 'server'
    online: boolean
    lastSeenAt: string | null
    createdAt: string
  }
  hardware: {
    hostname: string | null
    platform: string | null
    arch: string | null
    daemonVersion: string | null
    protocolVersion: number | null
    harnesses: HarnessInfo[]
  }
  access: { ownerId: string; canManage: boolean }
  directories: { environmentIds: string[]; root: string; updatedAt: string }[]
  scheduling: {
    enabled: boolean
    maxConcurrentRuns: number
    activeRuns: number
    availableSlots: number
  }
  checkpoints: DeviceCheckpoint[]
  cloudCheckpoints: {
    runId: string
    state: 'none' | 'creating' | 'ready' | 'failed' | 'unavailable'
    capturedAt: string | null
    available: boolean
  }[]
  migration: DeviceMigrationCapability
}

export interface DeviceCheckpoint {
  runId: string
  kind: 'repository'
  baseCommit: string
  files: number
  capturedAt: string
  available: boolean
  unavailableReason: 'too_large' | null
}

/** Repository checkpoints do not promise a transferable native machine image. */
export interface DeviceMigrationCapability {
  available: false
  reason: 'machine_migration_not_supported'
  preserves: ['repository_checkpoint']
  excludes: ['process_memory', 'native_session', 'ignored_files', 'credentials']
}

export interface WorkspaceContributionDay {
  day: string
  memberId: string
  completedTasks: number
  mergedPullRequests: number
  threads: number
}

export interface WorkspaceSettingsActivity {
  workspaceId: string
  from: string
  toExclusive: string
  timeZone: 'UTC'
  groupBy: 'member'
  /** Calendar dates are the persisted Mikka event dates, not inferred GitHub dates. */
  dateSource: 'recorded_events'
  contributions: WorkspaceContributionDay[]
  /** The complete model/machine ledger is owned by #2934. Unknown cost is null. */
  threadCosts: { available: false; reason: 'thread_cost_ledger_pending'; items: null }
}

export const threadCostsPending: WorkspaceSettingsActivity['threadCosts'] = {
  available: false, reason: 'thread_cost_ledger_pending', items: null,
}

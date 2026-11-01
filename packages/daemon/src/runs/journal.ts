// Local run journal (`runs.json`): what a restarted daemon needs to resume
// active runs through the adapter's `resume` (ADR 0004).
import {
  isTerminalRunState,
  type RunState,
  type StopReason,
} from "@mikka/protocol"

import type { RunSkillMount, RunExecution, RunRuntime } from "@mikka/protocol/run"

import { readJson, writeJsonAtomic } from "../fs-util"
import type { RunAssignment } from "../server-link"
import { withoutTaskEnv } from "../task-env"

/**
 * 4e3: the task's user variables (secrets) and the run's model credential live
 * in memory only, never in the journal file. A run that had a credential is
 * marked, so a restarted daemon stops it instead of running it without one.
 */
function persisted(entries: Record<string, JournalEntry>): Record<string, JournalEntry> {
  return Object.fromEntries(Object.entries(entries).map(([id, entry]) => {
    const { modelCredential, ...assignment } = withoutTaskEnv(entry.assignment) as RunAssignment
    return [id, { ...entry, assignment: assignment as RunAssignment, ...(modelCredential ? { credentialWithheld: true as const } : {}) }]
  }))
}

export interface JournalEntry {
  assignment: RunAssignment
  state: RunState
  sessionId: string | null
  worktree: string | null
  /** The commit the worktree started from; checkpoints diff against it. */
  baseCommit?: string
  /** Independent host reread, bound to the actual adapter session. */
  skillMount?: RunSkillMount
  execution?: RunExecution
  runtime?: RunRuntime
  /** Last seq assigned to this run's events. */
  lastSeq: number
  error: string | null
  /** Set once the run reached a terminal state. */
  stopReason?: StopReason
  /** Fail closed on a crash in the external session-message delivery window. */
  questionResumeState?: "starting" | "accepted"
  /** A durable help request still needs this worktree for its original session. */
  waitingQuestionId?: string
  /** The run was claimed with a model credential, which the journal file never holds. */
  credentialWithheld?: true
  updatedAt: string
}

export class RunJournal {
  private entries: Record<string, JournalEntry>

  constructor(private readonly file: string) {
    const raw = readJson(file) as { runs?: Record<string, JournalEntry> }
      | undefined
    this.entries = raw?.runs ?? {}
  }

  get(runId: string): JournalEntry | undefined {
    return this.entries[runId]
  }

  all(): JournalEntry[] {
    return Object.values(this.entries)
  }

  /** Runs a restarted daemon must pick back up. */
  active(): JournalEntry[] {
    return this.all().filter((entry) => !isTerminalRunState(entry.state))
  }

  put(entry: JournalEntry) {
    this.entries[entry.assignment.runId] = {
      ...entry,
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(this.file, { version: 1, runs: persisted(this.entries) })
  }

  update(runId: string, patch: Partial<Omit<JournalEntry, "assignment">>) {
    const current = this.entries[runId]
    if (!current) throw new Error(`journal: unknown run ${runId}`)
    this.put({ ...current, ...patch })
    return this.entries[runId]
  }
}

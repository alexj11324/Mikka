// Local run journal (`runs.json`): what a restarted daemon needs to resume
// active runs through the adapter's `resume` (ADR 0004).
import {
  isTerminalRunState,
  type RunState,
  type StopReason,
} from "@mikka/protocol"

import { readJson, writeJsonAtomic } from "../fs-util"
import type { RunAssignment } from "../server-link"

export interface JournalEntry {
  assignment: RunAssignment
  state: RunState
  sessionId: string | null
  worktree: string | null
  /** The commit the worktree started from; checkpoints diff against it. */
  baseCommit?: string
  /** Last seq assigned to this run's events. */
  lastSeq: number
  error: string | null
  /** Set once the run reached a terminal state. */
  stopReason?: StopReason
  updatedAt: string
}

export class RunJournal {
  private entries: Record<string, JournalEntry>

  constructor(private readonly file: string) {
    const raw = readJson(file) as
      | { runs?: Record<string, JournalEntry> }
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
    writeJsonAtomic(this.file, { version: 1, runs: this.entries })
  }

  update(runId: string, patch: Partial<Omit<JournalEntry, "assignment">>) {
    const current = this.entries[runId]
    if (!current) throw new Error(`journal: unknown run ${runId}`)
    this.put({ ...current, ...patch })
    return this.entries[runId]
  }
}

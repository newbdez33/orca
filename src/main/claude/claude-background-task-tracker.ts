import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'

const MAX_TRACKED_TASKS = 256
const MAX_TASK_ID_LENGTH = 512
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'killed', 'stopped'])

export type ClaudeBackgroundTaskKind = 'agent' | 'workflow' | 'command' | 'monitor' | 'unknown'

type TrackedTask = {
  backgrounded: boolean
  kind: ClaudeBackgroundTaskKind
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function taskId(message: Record<string, unknown>): string | null {
  const value = message.task_id
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TASK_ID_LENGTH
    ? value
    : null
}

export function classifyClaudeBackgroundTaskKind(taskType: unknown): ClaudeBackgroundTaskKind {
  switch (taskType) {
    case 'local_agent':
      return 'agent'
    case 'local_workflow':
      return 'workflow'
    case 'local_bash':
      return 'command'
    case 'monitor':
      return 'monitor'
    default:
      return 'unknown'
  }
}

export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, TrackedTask>()
  private readonly terminalTaskIds = new Set<string>()
  private aggregateRosterObserved = false
  private foregroundTurnActive = false
  private monitoring = false

  get state(): AgentSessionBackgroundTaskState | null {
    return this.monitoring ? { state: 'monitoring' } : null
  }

  get stoppableTaskIds(): string[] {
    const ids: string[] = []
    for (const [id, task] of this.tasks) {
      if (task.backgrounded) {
        ids.push(id)
      }
    }
    return ids
  }

  observe(message: Record<string, unknown>, startsTurn = false): boolean {
    if (startsTurn) {
      this.foregroundTurnActive = true
    }
    if (message.type === 'result') {
      this.foregroundTurnActive = false
    } else if (message.type === 'system') {
      this.observeSystemFrame(message)
    }
    return this.refreshMonitoring()
  }

  clear(): boolean {
    this.tasks.clear()
    this.terminalTaskIds.clear()
    this.aggregateRosterObserved = false
    this.foregroundTurnActive = false
    return this.refreshMonitoring()
  }

  private observeSystemFrame(message: Record<string, unknown>): void {
    if (message.subtype === 'background_tasks_changed') {
      this.replaceAggregateRoster(message.tasks)
      return
    }
    const id = taskId(message)
    if (!id) {
      return
    }
    if (message.subtype === 'task_notification') {
      this.finish(id)
      return
    }
    if (message.subtype === 'task_updated') {
      const patch = record(message.patch)
      if (!patch) {
        return
      }
      if (TERMINAL_TASK_STATES.has(String(patch.status))) {
        this.finish(id)
        return
      }
      if (patch.is_backgrounded === true && (!this.aggregateRosterObserved || this.tasks.has(id))) {
        this.upsert(id, { backgrounded: true, kind: this.tasks.get(id)?.kind ?? 'unknown' })
      }
      return
    }
    if (message.subtype !== 'task_started' || this.terminalTaskIds.has(id)) {
      return
    }
    if (message.ambient === true || message.skip_transcript === true) {
      this.finish(id)
      return
    }
    if (this.aggregateRosterObserved && !this.tasks.has(id)) {
      return
    }
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
    this.upsert(id, {
      backgrounded: message.is_backgrounded === true || kind === 'workflow' || kind === 'monitor',
      kind
    })
  }

  private replaceAggregateRoster(value: unknown): void {
    if (!Array.isArray(value)) {
      return
    }
    this.aggregateRosterObserved = true
    this.tasks.clear()
    this.terminalTaskIds.clear()
    for (const valueTask of value) {
      if (this.tasks.size >= MAX_TRACKED_TASKS) {
        break
      }
      const task = record(valueTask)
      if (!task || task.ambient === true) {
        continue
      }
      const id = taskId(task)
      if (!id) {
        continue
      }
      this.tasks.set(id, {
        backgrounded: true,
        kind: classifyClaudeBackgroundTaskKind(task.task_type)
      })
    }
  }

  private upsert(id: string, task: TrackedTask): void {
    const existing = this.tasks.get(id)
    if (existing) {
      this.tasks.set(id, {
        backgrounded: existing.backgrounded || task.backgrounded,
        kind: existing.kind === 'unknown' ? task.kind : existing.kind
      })
      return
    }
    if (this.tasks.size >= MAX_TRACKED_TASKS) {
      let foregroundId: string | undefined
      for (const [candidateId, candidate] of this.tasks) {
        if (!candidate.backgrounded) {
          foregroundId = candidateId
          break
        }
      }
      if (!foregroundId) {
        return
      }
      this.tasks.delete(foregroundId)
    }
    this.tasks.set(id, task)
  }

  private finish(id: string): void {
    this.tasks.delete(id)
    this.terminalTaskIds.delete(id)
    this.terminalTaskIds.add(id)
    if (this.terminalTaskIds.size > MAX_TRACKED_TASKS) {
      const oldest = this.terminalTaskIds.values().next()
      if (!oldest.done) {
        this.terminalTaskIds.delete(oldest.value)
      }
    }
  }

  private refreshMonitoring(): boolean {
    let next = false
    if (!this.foregroundTurnActive) {
      for (const task of this.tasks.values()) {
        if (task.backgrounded) {
          next = true
          break
        }
      }
    }
    if (next === this.monitoring) {
      return false
    }
    this.monitoring = next
    return true
  }
}

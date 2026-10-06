// The values this mod keeps in the session's state, and their shapes.

/** One piece of delegated work: a Claude subagent, or a relay call to Codex, agy, etc. */
export type Job = {
  /** The id of the tool call that started it. */
  id: string
  /** Who does the work: "Sonnet", "Haiku", "Opus", "Codex", "agy", "Claude CLI", ... */
  worker: string
  /** The model, when known ("gpt-6-luna", "claude-sonnet-5-5"), or the lane ("lane implement"). */
  model: string | null
  /** A short name for the task, from the delegation's description or brief. */
  title: string
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'done' | 'failed' | 'stopped'
  /** Started in the background, so finishing is noticed later rather than right away. */
  background: boolean
  /** The brief names one or two files at most: the kind of task solo did better on. */
  small: boolean
  /**
   * Text that appears in the command line of the job's process while it runs: the brief
   * path for relay.mjs jobs, the job id for background Codex plugin jobs. Used to tell
   * whether the job is still alive and to stop it. Null when the mod cannot stop it.
   */
  aliveMarker: string | null
  /** For Claude subagents: the subagent's id, which its requests and completion carry. */
  agentId: string | null
  /** Opus requests made, and their cost units, while this job was open. */
  opusRequests: number
  opusUnits: number
  /** The worker's own cost units (Claude subagents only; Codex reports no tokens here). */
  workerUnits: number
  /** Files the worker changed, when the relay reported it. */
  filesChanged: number | null
  /** Still counting Opus requests: true until the turn in which the job finished ends. */
  isTracking: boolean
}

/** Delegation totals for one calendar day, across all sessions. */
export type DayTotals = {
  jobs: number
  opusRequests: number
  opusUnits: number
  workerUnits: number
  relayCalls: number
}

declare module 'claude-code' {
  interface PluginState {
    delegation: {
      /** Every delegation in this session, oldest first. */
      jobs: Job[]
      /** Today's totals, shared by all sessions through the store. */
      today: DayTotals
      /** The current time, refreshed on a timer so elapsed times redraw. */
      now: number
    }
  }
}

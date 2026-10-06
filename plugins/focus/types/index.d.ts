// The values this mod keeps in the session's state, and their shapes.

/** One entry of Claude's task list, as seen from its TaskCreate / TaskUpdate calls. */
export type Task = {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** One finished thing. `at` is when, in milliseconds since 1970. */
export type Win = { text: string; at: number }

/** What you are working on right now. */
export type Current = {
  /** Short name of the task: the in-progress task's subject, or your first prompt. */
  title: string
  /** When this task started. */
  startedAt: number
  /** Minutes Claude estimated for it, if a reply gave one. */
  estimateMinutes: number | null
}

declare module 'claude-code' {
  interface PluginState {
    focus: {
      /** The pinned next action, or null when the last reply had none. */
      next: string | null
      /** True once Claude has replied at least once (so "no next action" means something). */
      hasReply: boolean
      /** The task in progress, or null between tasks. */
      current: Current | null
      /** Claude's task list for this session; empty when it is not using one. */
      tasks: Task[]
      /** Thoughts set aside for later. Saved per project folder. */
      parked: string[]
      /** Things finished today. Saved across all sessions, reset each day. */
      wins: Win[]
      /** When you last sent a prompt or Claude last finished a turn. */
      lastActivityAt: number
      /** When this session started. */
      sessionStartedAt: number
      /** The last "where you left off" summary Claude wrote, if you asked for one. */
      recap: string | null
      /** The current time, refreshed on a timer so the clocks redraw. */
      now: number
    }
  }
}

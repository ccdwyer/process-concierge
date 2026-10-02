export type ProcStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'unsupervised'

// The supervisor (bin/pc-run) that leads a job's process group: the only process this mod ever asks to stop.
export type Supervisor = { pid: number; lstart: string }

// One job the agent started. Jobs launched through the supervisor can be stopped; anything else is shown only.
export type Proc = {
  id: string
  // The job's supervisor token: names its ledger files and appears in the supervisor's command line.
  token: string
  sessionId: string
  // The launched command with env assignments removed and secret-looking values hidden.
  command: string
  // Digests of folder + job identity: what counts as "the same server" for the duplicate check. A
  // run-in-background line that starts several servers under one supervisor has one per server.
  keys: string[]
  // The ports the command asked for, where it named them.
  wants: number[]
  // The folder the job runs in, symlinks resolved.
  cwd: string
  startedAt: number
  // 'task' ends with the call that launched it; 'detached' was sent to the background with `&`.
  mode: 'task' | 'detached'
  supervisor: Supervisor | null
  // Pids in the supervisor's process group at the last look (display only; never signalled).
  members: number[]
  ports: number[]
  status: ProcStatus
  cpu: number
  memMb: number
  exitCode: number | null
  taskId?: string
  stopAt?: number
  checkedAt: number
  note: string
}

// A listener on the machine that this mod did not start: shown read-only.
export type Foreign = { pid: number; ports: number[]; command: string }

export type View = {
  sessionId: string
  procs: Proc[]
  foreign: Foreign[]
  updatedAt: number
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'process-concierge': { view: View }
  }
}

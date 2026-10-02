export type Ident = { pid: number; lstart: string }

export type ProcStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'exited' | 'unconfirmed'

// One job (process tree) the agent started and this mod tracks.
export type Proc = {
  id: string
  sessionId: string
  // The launched command with env assignments removed and secret-looking values hidden.
  command: string
  // Words a matching OS process's command line must contain, as whole tokens.
  match: string[]
  // A digest of folder + job identity: what counts as "the same server" for the duplicate check.
  // Only the digest is kept, so no argument value (a token, say) is ever stored.
  key: string
  // The port the command asked for, when it named one.
  port: number | null
  // The folder the job runs in, symlinks resolved.
  cwd: string
  startedAt: number
  // True when the job was the only one its tool call launched, so a server whose launcher already exited
  // can still be matched to it by folder and start time.
  solo: boolean
  // Every process of the tree proven to be ours, each with the start time it had when recorded.
  tree: Ident[]
  ports: number[]
  status: ProcStatus
  cpu: number
  memMb: number
  taskId?: string
  // When a stop began: a process of ours that appears after this is a respawn, not a new job.
  stopAt?: number
  checkedAt: number
  note: string
}

export type View = {
  sessionId: string
  procs: Proc[]
  updatedAt: number
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'process-concierge': { view: View }
  }
}

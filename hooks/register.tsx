import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Ident, Proc, View } from '../types'
import type { EnvInfo, PsRow } from './procs'
import {
  SIGNAL_SCRIPT, age, commandMatches, descendants, descendsFrom, detaches, display, identity, jobs, longRunner,
  matchWords, parseCwds, parseEnv, parseLsof, parsePs, requestedPort, roots, short, startDir, stillOurs,
} from './procs'

type Engine = EngineInterface

const PANE = 'process-concierge'
const VIEW = { plugin: 'process-concierge', key: 'view' } as const
const STORE_PREFIX = 'proc:'
// How often live processes are re-checked while the session is open.
const TICK_MS = 15_000
// When a just-started process is looked for again, after the immediate look.
const RETRIES_MS = [1_500, 5_000, 15_000]
// A started job that shows no provable process by then is marked unconfirmed.
const CONFIRM_WITHIN_MS = 60_000
// A job still looking for its process holds its port and name only this long.
const STARTING_HOLD_MS = 15_000
// A process found without a "before" look must have started this close to the command.
const WINDOW_MS = 30_000
// How long SIGTERM gets before SIGKILL, and how long SIGKILL gets before the stop is judged.
const GRACE_MS = 3_000
const KILL_WAIT_MS = 1_500
// Finished and unconfirmed records are forgotten after this long.
const KEEP_FINISHED_MS = 6 * 3600_000
// `ps` and `lsof` print dates in the C locale, so every reader parses the same text.
const C_LOCALE = { LC_ALL: 'C' }

// The session's own memory. The store is the durable copy; a reload rebuilds this from it.
let procs: Proc[] = []
let sessionId = ''
// Every session id and Claude Code pid this process has had: what a process's environment is checked against.
const sessionIds = new Set<string>()
const hostPids = new Set<number>()
let home = ''
let counter = 0
let ticker: { cancel: () => void } | null = null
// Pids that existed just before each tracked command ran; absent when that look failed.
const before = new Map<string, Set<number>>()

type Ran = { exitCode: number; stdout: string; stderr: string; truncated: boolean }

async function run($: Engine, argv: string[], timeoutMs = 5_000): Promise<Ran> {
  try {
    const r = await $.process.run(argv, { timeoutMs, env: C_LOCALE })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, truncated: r.isStdoutTruncated }
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err).slice(0, 200), truncated: false }
  }
}

// The whole process table, or null when it could not be read in full.
async function psRows($: Engine): Promise<PsRow[] | null> {
  const r = await run($, ['ps', '-axww', '-o', 'pid=,ppid=,pcpu=,rss=,lstart=,command='])
  if (r.exitCode !== 0 || r.truncated) return null
  const rows = parsePs(r.stdout)
  return rows.length > 0 ? rows : null
}

// Every TCP listener on the machine: pid -> ports.
async function listening($: Engine): Promise<Map<number, number[]>> {
  const r = await run($, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])
  // lsof exits 1 when nothing listens.
  return r.exitCode === 0 || r.exitCode === 1 ? parseLsof(r.stdout) : new Map()
}

async function cwdsOf($: Engine, pids: number[]): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map()
  const r = await run($, ['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', pids.slice(0, 40).join(',')])
  return parseCwds(r.stdout)
}

// What each process's environment says, where the OS shows it (it hides it for its own signed binaries).
async function envOf($: Engine, pids: number[]): Promise<Map<number, EnvInfo>> {
  if (pids.length === 0) return new Map()
  const r = await run($, ['ps', '-E', '-ww', '-o', 'pid=,command=', '-p', pids.slice(0, 40).join(',')])
  // ps exits 1 when some of the pids are gone; the rest still print.
  return r.exitCode === 0 || r.exitCode === 1 ? parseEnv(r.stdout) : new Map()
}

async function realDir($: Engine, dir: string): Promise<string> {
  try {
    const stat = await $.fs.stat(dir, { resolve: true })
    return stat.realPath ?? dir
  } catch {
    return dir
  }
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const alive = (p: Proc) => p.status === 'running' || p.status === 'starting' || p.status === 'stopping'

// What holds a port and a job name: anything running, and a just-started job for a short while.
function occupies(p: Proc, now: number): boolean {
  if (p.status === 'running' || p.status === 'stopping') return true
  return p.status === 'starting' && now - p.startedAt < STARTING_HOLD_MS
}

function visible(): Proc[] {
  return procs.filter(p => alive(p) || p.sessionId === sessionId || p.status === 'unconfirmed')
}

async function publish($: Engine, note = ''): Promise<void> {
  const view: View = { sessionId, procs: visible(), updatedAt: await $.clock.now(), note }
  try {
    await $.state.set(VIEW, view)
  } catch {
    // A failed redraw must never fail the caller.
  }
}

async function persist($: Engine, p: Proc): Promise<void> {
  try {
    await $.store.set(`${STORE_PREFIX}${p.id}`, p)
  } catch {
    // The store is best effort.
  }
}

async function forget($: Engine, id: string): Promise<void> {
  procs = procs.filter(p => p.id !== id)
  before.delete(id)
  try {
    await $.store.delete(`${STORE_PREFIX}${id}`)
  } catch {
    // Already gone.
  }
}

function isProc(v: unknown): v is Proc {
  const p = v as Proc
  return typeof p === 'object' && p !== null && typeof p.id === 'string' && Array.isArray(p.tree) && Array.isArray(p.match)
}

async function loadStore($: Engine): Promise<void> {
  const loaded: Proc[] = []
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX)) continue
      const v = await $.store.get(key)
      if (isProc(v)) loaded.push(v)
    }
  } catch {
    // Start empty.
  }
  // Records from this module's own memory win over the stored copy.
  const ids = new Set(procs.map(p => p.id))
  procs = [...procs, ...loaded.filter(p => !ids.has(p.id))]
}

// Is this process provably one Claude Code started? A descendant of this Claude Code process is; so is one
// whose environment carries this Claude Code's pid or session id (it survives a launcher exiting). An
// environment the OS shows without either is someone else's. The folder a process runs in proves nothing.
function proof(r: PsRow, rows: PsRow[], env: Map<number, EnvInfo>): 'ours' | 'not-ours' | 'unknown' {
  for (const host of hostPids) if (descendsFrom(rows, r.pid, host)) return 'ours'
  const info = env.get(r.pid)
  if (info === undefined || !info.visible) return 'unknown'
  if (info.claudePid !== undefined && hostPids.has(info.claudePid)) return 'ours'
  if (info.sessionId !== undefined && sessionIds.has(info.sessionId)) return 'ours'
  return 'not-ours'
}

function startedNear(r: PsRow, p: Proc): boolean {
  const t = Date.parse(r.lstart)
  return Number.isFinite(t) && t >= p.startedAt - 2_000 && t <= p.startedAt + WINDOW_MS
}

// Pids already in the tree of some other live record: one process belongs to one job.
function claimedBesides(p: Proc | null): Set<number> {
  const out = new Set<number>()
  for (const q of procs) if (q !== p && alive(q)) for (const x of q.tree) out.add(x.pid)
  return out
}

function treeOf(rows: PsRow[], tops: PsRow[], claimed: Set<number>): Ident[] {
  const byPid = new Map(rows.map(r => [r.pid, r]))
  const tree: Ident[] = []
  for (const top of tops.slice(0, 8)) {
    for (const pid of [top.pid, ...descendants(rows, top.pid)]) {
      const row = byPid.get(pid)
      if (row !== undefined && !claimed.has(pid) && !tree.some(x => x.pid === pid)) tree.push({ pid, lstart: row.lstart })
    }
  }
  return tree
}

// Find the processes a job started and keep only those provably ours, unclaimed by any other job.
async function discover($: Engine, p: Proc, rows: PsRow[], claimed: Set<number>): Promise<Ident[]> {
  const seen = before.get(p.id)
  const fresh = rows.filter(r => !claimed.has(r.pid) && (seen !== undefined ? !seen.has(r.pid) : startedNear(r, p)))
  let candidates = roots(fresh.filter(r => commandMatches(r.command, p.match)))
  // The launcher (npm, say) may have exited before the first look, leaving only its server: for the one job a
  // call started, accept a fresh process in the job's folder that started with the command.
  let byFolder = false
  if (candidates.length === 0 && p.solo) {
    candidates = roots(fresh.filter(r => startedNear(r, p)))
    byFolder = true
  }
  if (candidates.length === 0) return []
  candidates = candidates.slice(0, 16)
  const env = await envOf($, candidates.map(r => r.pid))
  const cwds = await cwdsOf($, candidates.map(r => r.pid))
  const proven = candidates.filter(r => proof(r, rows, env) === 'ours' && (!byFolder || cwds.get(r.pid) === p.cwd))
  if (proven.length === 0) return []
  // Two jobs of one call in different folders: each keeps the processes running in its own folder.
  const inFolder = proven.filter(r => cwds.get(r.pid) === p.cwd)
  return treeOf(rows, inFolder.length > 0 ? inFolder : proven, claimed)
}

async function discoverAll($: Engine, rows: PsRow[]): Promise<void> {
  for (const p of procs.filter(x => x.status === 'starting' && x.tree.length === 0)) {
    const tree = await discover($, p, rows, claimedBesides(p))
    if (tree.length > 0) {
      p.tree = tree
      p.status = 'running'
    }
  }
}

// Members of the tree that are still ours, plus any new children they have spawned since.
function liveTree(p: Proc, rows: PsRow[]): Ident[] {
  const ours = stillOurs(p.tree, rows)
  const byPid = new Map(rows.map(r => [r.pid, r]))
  const grown = [...ours]
  for (const x of ours) {
    for (const pid of descendants(rows, x.pid)) {
      const row = byPid.get(pid)
      if (row !== undefined && !grown.some(y => y.pid === pid)) grown.push({ pid, lstart: row.lstart })
    }
  }
  return grown
}

// Re-check every live record: which of its processes are still ours, their ports, CPU and memory.
// A caller that already read the process table passes it in, so one tool call reads it once.
async function refresh($: Engine, rowsIn?: PsRow[] | null, portsIn?: Map<number, number[]>): Promise<void> {
  try {
    sessionId = await $.session.id()
    sessionIds.add(sessionId)
  } catch {
    // Keep the last known id.
  }
  const now = await $.clock.now()
  for (const p of procs.filter(x => !alive(x) && now - x.checkedAt > KEEP_FINISHED_MS)) await forget($, p.id)
  const live = procs.filter(alive)
  if (live.length === 0) {
    await publish($)
    return
  }
  const rows = rowsIn === undefined ? await psRows($) : rowsIn
  // A failed look changes nothing: absence is never inferred from a failed read.
  if (rows === null) return
  const ports = portsIn ?? (await listening($))
  const byPid = new Map(rows.map(r => [r.pid, r]))
  await discoverAll($, rows)
  for (const p of live) {
    if (p.status === 'starting') {
      if (now - p.startedAt > CONFIRM_WITHIN_MS) {
        p.status = 'unconfirmed'
        p.note = 'could not prove which process this started, so it has no stop button'
      }
    } else {
      const tree = liveTree(p, rows)
      p.tree = tree.length > 0 ? tree : p.tree
      if (tree.length === 0) {
        p.status = p.status === 'stopping' ? 'stopped' : 'exited'
        p.ports = []
        p.cpu = 0
        p.memMb = 0
      } else {
        const pids = tree.map(x => x.pid)
        p.ports = [...new Set(pids.flatMap(pid => ports.get(pid) ?? []))].sort((a, b) => a - b)
        p.cpu = Math.round(pids.reduce((sum, pid) => sum + (byPid.get(pid)?.cpu ?? 0), 0) * 10) / 10
        p.memMb = Math.round(pids.reduce((sum, pid) => sum + (byPid.get(pid)?.rssKb ?? 0), 0) / 1024)
      }
    }
    p.checkedAt = now
    await persist($, p)
  }
  await publish($)
}

// Signal each member only if, at that moment, its pid still has the start time recorded for it.
async function signal($: Engine, sig: 'TERM' | 'KILL', tree: Ident[]): Promise<number[]> {
  if (tree.length === 0) return []
  const specs = tree.map(x => `${x.pid}:${x.lstart}`)
  const r = await run($, ['sh', '-c', SIGNAL_SCRIPT, 'sh', sig, ...specs], 8_000)
  return r.stdout.split('\n').map(Number).filter(n => n > 0)
}

async function cannotConfirm($: Engine, p: Proc): Promise<void> {
  p.status = 'running'
  p.note = 'could not read the process list to finish stopping it; press stop again'
  await persist($, p)
  await publish($, p.note)
}

// Stop one tracked job.
async function stopProc($: Engine, id: string): Promise<string> {
  const p = procs.find(x => x.id === id)
  if (p === undefined || (p.status !== 'running' && p.status !== 'stopping')) return 'not running'
  const rows = await psRows($)
  if (rows === null) {
    p.note = 'could not read the process list; nothing was signalled. Try again.'
    await publish($, p.note)
    return p.note
  }
  const ours = liveTree(p, rows)
  const sent = await signal($, 'TERM', ours)
  if (sent.length === 0) {
    p.status = 'exited'
    p.tree = []
    await persist($, p)
    await publish($)
    return 'already gone'
  }
  p.tree = ours
  p.status = 'stopping'
  p.stopAt = await $.clock.now()
  p.note = ''
  await persist($, p)
  await publish($, `Stopping ${short(p.command, 40)}…`)
  $.clock.after(GRACE_MS, () => {
    void escalate($, id)
  })
  return `sent SIGTERM to ${sent.length} process${sent.length === 1 ? '' : 'es'}`
}

// After the grace period: SIGKILL whatever is still ours, children spawned during the grace included.
async function escalate($: Engine, id: string): Promise<void> {
  const p = procs.find(x => x.id === id)
  if (p === undefined || p.status !== 'stopping') return
  const rows = await psRows($)
  if (rows === null) {
    await cannotConfirm($, p)
    return
  }
  const left = liveTree(p, rows)
  if (left.length === 0) {
    await settle($, id, rows)
    return
  }
  p.tree = left
  await signal($, 'KILL', left)
  $.clock.after(KILL_WAIT_MS, () => {
    void settle($, id)
  })
}

// A process of ours matching this job that started after the stop began: a supervisor restarted it.
async function respawned($: Engine, p: Proc, rows: PsRow[]): Promise<Ident[]> {
  const since = (p.stopAt ?? p.startedAt) - 1_000
  const claimed = claimedBesides(p)
  const fresh = rows.filter(r => !claimed.has(r.pid) && Date.parse(r.lstart) >= since && commandMatches(r.command, p.match))
  const tops = roots(fresh).slice(0, 8)
  if (tops.length === 0) return []
  const env = await envOf($, tops.map(r => r.pid))
  return treeOf(rows, tops.filter(r => proof(r, rows, env) === 'ours'), claimed)
}

async function settle($: Engine, id: string, rowsIn?: PsRow[]): Promise<void> {
  const p = procs.find(x => x.id === id)
  if (p === undefined) return
  const rows = rowsIn ?? (await psRows($))
  if (rows === null) {
    await cannotConfirm($, p)
    return
  }
  const left = liveTree(p, rows)
  if (left.length > 0) {
    p.tree = left
    p.status = 'running'
    p.note = `stop failed for pid ${left.map(x => x.pid).join(',')}; it may need elevated rights`
  } else {
    const again = await respawned($, p, rows)
    if (again.length > 0) {
      p.tree = again
      p.status = 'running'
      p.note = 'it started again during the stop (something restarted it); press stop again'
    } else {
      p.status = 'stopped'
      p.ports = []
      p.note = ''
    }
  }
  await persist($, p)
  await publish($)
}

async function stopMany($: Engine, which: 'session' | 'orphans'): Promise<string> {
  const targets = procs.filter(p => p.status === 'running' && (which === 'session' ? p.sessionId === sessionId : p.sessionId !== sessionId))
  for (const p of targets) await stopProc($, p.id)
  return `${targets.length} stopping`
}

async function dismissFinished($: Engine): Promise<void> {
  for (const p of procs.filter(x => !alive(x))) await forget($, p.id)
  await publish($)
}

function describe(p: Proc): string {
  const pids = p.tree.map(x => x.pid).slice(0, 4).join(',') || '?'
  const ports = p.ports.length > 0 ? ` on ${p.ports.map(n => `:${n}`).join(' ')}` : ''
  return `pid ${pids}${ports} (${short(p.command, 100)}, started ${age(Date.now() - p.startedAt)} ago in ${p.cwd})`
}

function summary(list: Proc[]): string {
  const live = list.filter(p => p.status === 'running' || p.status === 'stopping')
  if (live.length === 0) return 'Process Concierge: no tracked processes are running.'
  const lines = live.map(p => `- ${describe(p)}${p.sessionId === sessionId ? '' : ' [earlier session]'}`)
  return `Process Concierge: ${live.length} running.\n${lines.join('\n')}`
}

type Planned = { text: string; dir: string; key: string; port: number | null }

// What a new job would collide with: a listener or a reservation on the port it asks for, the same job
// already running in that folder, or an earlier job of the same command.
function conflictFor(x: Planned, listeners: Map<number, number[]>, rows: PsRow[] | null, now: number, ports: number[], earlier: Planned[]): string | null {
  const want = x.port
  if (want !== null) {
    if (ports.includes(want)) return `this command starts two things on port ${want}`
    for (const [pid, held] of listeners) {
      if (!held.includes(want)) continue
      const owner = procs.find(p => occupies(p, now) && p.tree.some(t => t.pid === pid))
      if (owner !== undefined) return `port ${want} is already served by a process the agent started: ${describe(owner)}`
      const row = rows?.find(r => r.pid === pid)
      return `port ${want} is already in use by pid ${pid}${row ? ` (${display(row.command).slice(0, 60)})` : ''}, which was not started through this session`
    }
    const reserving = procs.find(p => occupies(p, now) && (p.port === want || p.ports.includes(want)))
    if (reserving !== undefined) return `port ${want} is taken by a server the agent just started in ${reserving.cwd}, which is still coming up`
  }
  // Earlier in this same command: the same job twice, unless the two name different ports.
  if (earlier.some(y => y.key === x.key && (x.port === null || y.port === null || x.port === y.port))) return 'this command starts the same job twice'
  for (const p of procs) {
    if (!occupies(p, now) || p.key !== x.key) continue
    // Same job in the same folder: a duplicate unless it explicitly asks for a port the running one does not use.
    if (x.port !== null && p.port !== x.port && !p.ports.includes(x.port)) continue
    return p.status === 'starting'
      ? `the same command was just started in ${p.cwd} and is still coming up`
      : `this is already running: ${describe(p)}`
  }
  return null
}

function newProc(x: Planned, now: number, solo: boolean): Proc {
  counter += 1
  return {
    id: `${sessionId.slice(0, 8)}-${now}-${counter}`, sessionId, command: display(x.text), match: matchWords(x.text),
    key: x.key, port: x.port, cwd: x.dir, startedAt: now, solo, tree: [], ports: [],
    status: 'starting', cpu: 0, memMb: 0, checkedAt: now, note: '',
  }
}

async function plan($: Engine, cmd: string, background: boolean): Promise<Planned[]> {
  const cwd = await $.session.cwd()
  const out: Planned[] = []
  for (const job of jobs(cmd, background)) {
    const dir = await realDir($, startDir(cmd, job.index, cwd, home))
    out.push({ text: job.text, dir, key: await digest(`${dir}\u0000${identity(job.text)}`), port: requestedPort(job.text) })
  }
  return out
}

// After a call returns with processes left running: look for them now and a few more times, and tell the model.
async function track($: Engine, ids: string[], taskId: string | undefined): Promise<string> {
  for (const p of procs.filter(x => ids.includes(x.id))) p.taskId = taskId
  await refresh($)
  for (const ms of RETRIES_MS) {
    $.clock.after(ms, () => {
      void refresh($)
    })
  }
  const mine = procs.filter(x => ids.includes(x.id))
  const found = mine.filter(x => x.tree.length > 0)
  return (
    `Process Concierge is tracking ${mine.length === 1 ? 'this background process' : `${mine.length} background processes`}` +
    (found.length > 0 ? `: ${found.map(describe).join('; ')}` : '') +
    `. Before starting it again, check whether it is still running; the user can see and stop it with /procs.`
  )
}

// The call's result with a note for the model added; a refusal stays as it is.
function withNote(ran: ToolCallResult, note: string): ToolCallResult {
  if (ran.deny !== undefined) return ran
  return { ...ran, context: [...(ran.context ?? []), note] }
}

type BashResult = { backgroundTaskId?: string; backgroundEndsWithFinalResponse?: boolean } | undefined

async function startTicker($: Engine): Promise<void> {
  ticker?.cancel()
  ticker = $.clock.every(TICK_MS, () => {
    void refresh($)
  })
}

async function boot($: Engine): Promise<void> {
  sessionId = await $.session.id()
  sessionIds.add(sessionId)
  home = (await $.env.get('HOME')) ?? ''
  const host = await run($, ['sh', '-c', 'echo $PPID $CLAUDE_PID'], 2_000)
  for (const n of host.stdout.trim().split(/\s+/).map(Number)) if (n > 1) hostPids.add(n)
  await loadStore($)
  await refresh($)
  await startTicker($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'procs',
        description: 'Process Concierge: show the processes the agent started, with ports and stop buttons',
        argumentHint: '[stop-all | clean]',
        immediate: true,
      })
      await boot($)
    } catch {
      // Never hold up the session.
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear and resume keep the process alive on a new session: keep watching.
    const reason = String(e.reason)
    if (reason !== 'clear' && reason !== 'resume') {
      ticker?.cancel()
      ticker = null
    }
    return next(e)
  })

  on('command.run', { command: 'procs' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    if (ticker === null) await boot($)
    if (arg === 'stop-all') return { text: `Process Concierge: ${await stopMany($, 'session')} from this session.` }
    if (arg === 'clean') return { text: `Process Concierge: ${await stopMany($, 'orphans')} from earlier sessions.` }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Processes' })
    return { text: summary(procs) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String(e.command ?? '')
    const background = e.run_in_background === true
    if (!background && longRunner(cmd) === null && !detaches(cmd)) {
      // Not expected to outlive the call, but Claude Code can move it to the background (a timeout, Ctrl+B).
      const startedAt = await $.clock.now()
      const ran = await next(e)
      try {
        const result = ran.result as BashResult
        if (ran.isError === true || result?.backgroundTaskId === undefined || result.backgroundEndsWithFinalResponse === true) return ran
        const planned = await plan($, cmd, true)
        if (planned.length === 0) return ran
        const late = planned.map(x => newProc(x, startedAt, planned.length === 1))
        procs.push(...late)
        const note = await track($, late.map(p => p.id), result.backgroundTaskId)
        return withNote(ran, note)
      } catch {
        return ran
      }
    }

    const ids: string[] = []
    try {
      const rows = await psRows($)
      const listeners = await listening($)
      // One read of the process table serves the refresh, the duplicate check and the "before" look.
      await refresh($, rows, listeners)
      const planned = await plan($, cmd, background)
      const now = await $.clock.now()
      // From here to the reservation there is no await: check and reserve are one step, so overlapping calls
      // can't both pass. Ports and jobs reserved earlier in this same command count too.
      const ports: number[] = []
      const earlier: Planned[] = []
      for (const x of planned) {
        const conflict = conflictFor(x, listeners, rows, now, ports, earlier)
        if (conflict !== null) {
          return {
            deny:
              `Process Concierge: not started, because ${conflict}. ` +
              `Reuse the running one. If it really must restart, the user can stop it in /procs first.`,
          }
        }
        if (x.port !== null) ports.push(x.port)
        earlier.push(x)
      }
      const seen = rows === null ? undefined : new Set(rows.map(r => r.pid))
      for (const x of planned) {
        const p = newProc(x, now, planned.length === 1)
        procs.push(p)
        ids.push(p.id)
        if (seen !== undefined) before.set(p.id, seen)
      }
    } catch {
      // Tracking is best effort; the command always runs.
    }

    const ran = await next(e)
    try {
      const result = ran.result as BashResult
      const keep =
        ran.deny === undefined && ran.isError !== true && result?.backgroundEndsWithFinalResponse !== true &&
        (result?.backgroundTaskId !== undefined || detaches(cmd))
      if (!keep) {
        for (const id of ids) await forget($, id)
        await publish($)
        return ran
      }
      const note = await track($, ids, result?.backgroundTaskId)
      return withNote(ran, note)
    } catch {
      return ran
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { value } = await $.state.get(VIEW)
    const live = (value?.procs ?? []).filter(p => p.status === 'running' || p.status === 'stopping')
    if (live.length === 0) return below
    const { Box, Text } = $.ui.resolve(e)
    const ports = [...new Set(live.flatMap(p => p.ports))].sort((a, b) => a - b)
    const orphans = live.filter(p => p.sessionId !== value?.sessionId).length
    const portText = ports.length > 0 ? ` · ${ports.slice(0, 6).map(n => `:${n}`).join(' ')}` : ''
    const orphanText = orphans > 0 ? ` · ${orphans} from earlier sessions` : ''
    return (
      <Box flexDirection="column">
        <Text dimColor>
          ⚙ {live.length} running{portText}{orphanText} · /procs
        </Text>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { value } = await $.state.get(VIEW)
    const list = value?.procs ?? []
    const now = value?.updatedAt ?? 0
    const cols = Math.max(40, e.props.bodyColumns ?? 80)
    const running = (p: Proc) => p.status === 'running'
    const mine = list.filter(p => running(p) && p.sessionId === value?.sessionId).length
    const orphans = list.filter(p => running(p) && p.sessionId !== value?.sessionId).length
    const finished = list.filter(p => !alive(p)).length
    return (
      <Box flexDirection="column">
        <Box>
          <Button key="refresh" label="refresh" onPress={() => refresh($)} />
          {mine > 0 ? <Button key="stop-all" label={`stop all from this session (${mine})`} onPress={() => stopMany($, 'session')} /> : null}
          {orphans > 0 ? <Button key="clean" label={`clean up earlier sessions (${orphans})`} onPress={() => stopMany($, 'orphans')} /> : null}
          {finished > 0 ? <Button key="dismiss" label="clear finished" onPress={() => dismissFinished($)} /> : null}
        </Box>
        {value?.note ? <Text dimColor>{value.note}</Text> : null}
        {list.length === 0 ? <Text dimColor>Nothing tracked yet. Background processes the agent starts show up here.</Text> : null}
        {list.map(p => {
          const glyph = p.status === 'running' ? '●' : p.status === 'starting' ? '◌' : p.status === 'stopping' ? '◐' : '○'
          const pids = p.tree.map(x => x.pid).slice(0, 4).join(',') || '…'
          const ports = p.ports.length > 0 ? p.ports.map(n => `:${n}`).join(' ') : 'no port'
          const who = p.sessionId === value?.sessionId ? '' : ' · earlier session'
          return (
            <Box key={p.id} flexDirection="column" marginTop={1}>
              <Text color={running(p) ? 'green' : undefined} dimColor={!running(p)}>
                {glyph} {short(p.command, cols - 12)}
              </Text>
              <Text dimColor>
                {'  '}pid {pids} · {ports} · {p.status} {age(now - p.startedAt)} · {p.cpu}% cpu · {p.memMb} MB{who}
              </Text>
              {p.note ? <Text color="yellow">{'  '}{short(p.note, cols - 4)}</Text> : null}
              <Box>
                <Text dimColor>{'  '}{short(p.cwd, cols - 16)} </Text>
                {running(p) ? <Button key={`stop-${p.id}`} label="stop" onPress={() => stopProc($, p.id)} /> : null}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}

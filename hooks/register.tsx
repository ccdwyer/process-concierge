import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Foreign, Proc, View } from '../types'
import type { Job, Mode, PsRow } from './procs'
import {
  TOKEN, age, commandOf, detaches, display, groupMembers, identity, jobs, longRunner, parseExit, parseLedger, parseLsof,
  parsePs, requestedPort, short, startDir, supervisorRow, wrap,
} from './procs'

type Engine = EngineInterface

const PANE = 'process-concierge'
const VIEW = { plugin: 'process-concierge', key: 'view' } as const
const STORE_PREFIX = 'proc:'
// How often live jobs are re-checked while the session is open.
const TICK_MS = 15_000
// When a just-started job is looked for again, after the immediate look.
const RETRIES_MS = [1_500, 5_000, 15_000]
// A job whose supervisor has not checked in by then ran without it (for example, no perl on this machine).
const CONFIRM_WITHIN_MS = 30_000
// A job still coming up holds its port and name only this long.
const STARTING_HOLD_MS = 15_000
// When a stop is judged: after the supervisor's 3s grace and its SIGKILL, then once more, finally.
const SETTLE_MS = [4_500, 12_000]
// A stopping job with no settling timer left (a reload) is judged by the regular refresh after this long.
const STOP_ORPHANED_MS = 15_000
// Finished records are forgotten after this long.
const KEEP_FINISHED_MS = 6 * 3600_000
// `ps` and `lsof` print dates in the C locale, so every reader parses the same text.
const C_LOCALE = { LC_ALL: 'C' }

// The session's own memory. The store is the durable copy; a reload rebuilds this from it.
let procs: Proc[] = []
let sessionId = ''
let home = ''
let ledgerDir = ''
let script = ''
// The shell the Bash tool runs commands in, so a supervised job is run by the same one.
let shell = '/bin/sh'
let counter = 0
let ticker: { cancel: () => void } | null = null
// Each rewritten command, to the arguments the model asked for and the exact arguments the call carries after
// the rewrite: the permission check for exactly that rewritten call is the check for the original.
const rewrites = new Map<string, { original: Record<string, unknown>; rewritten: Record<string, unknown> }>()

// Equal as permission inputs: every argument the same, a missing one and an undefined one alike.
function sameArgs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false
  return true
}

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
  const r = await run($, ['ps', '-axww', '-o', 'pid=,ppid=,pgid=,pcpu=,rss=,lstart=,command='])
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

async function realDir($: Engine, dir: string): Promise<string> {
  try {
    const stat = await $.fs.stat(dir, { resolve: true })
    return stat.realPath ?? dir
  } catch {
    return dir
  }
}

async function exists($: Engine, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function newToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function readFile($: Engine, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

// Remove a job's ledger files. The token is checked to be ours in shape, so the paths can name nothing else.
async function removeLedger($: Engine, token: string): Promise<void> {
  if (!TOKEN.test(token) || ledgerDir === '') return
  const files = ['run', 'exit', 'stop', 'code', 'ps'].map(ext => `${ledgerDir}/${token}.${ext}`)
  await run($, ['rm', '-f', '--', ...files], 3_000)
}

const alive = (p: Proc) => p.status === 'running' || p.status === 'starting' || p.status === 'stopping'

// What holds a port and a job name: anything running, and a just-started job for a short while.
function occupies(p: Proc, now: number): boolean {
  if (p.status === 'running' || p.status === 'stopping') return true
  return p.status === 'starting' && now - p.startedAt < STARTING_HOLD_MS
}

function visible(): Proc[] {
  return procs.filter(p => alive(p) || p.sessionId === sessionId || p.status === 'unsupervised')
}

let foreign: Foreign[] = []

async function publish($: Engine, note = ''): Promise<void> {
  const view: View = { sessionId, procs: visible(), foreign, updatedAt: await $.clock.now(), note }
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
  const p = procs.find(x => x.id === id)
  procs = procs.filter(x => x.id !== id)
  if (p !== undefined) await removeLedger($, p.token)
  try {
    await $.store.delete(`${STORE_PREFIX}${id}`)
  } catch {
    // Already gone.
  }
}

function isProc(v: unknown): v is Proc {
  const p = v as Proc
  return typeof p === 'object' && p !== null && typeof p.id === 'string' && typeof p.token === 'string' && Array.isArray(p.members) && Array.isArray(p.keys)
}

async function loadStore($: Engine): Promise<void> {
  const loaded: Proc[] = []
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX)) continue
      const v = await $.store.get(key)
      if (isProc(v)) loaded.push(v)
      // Records from before the supervisor (no token) can't be stopped safely: drop them.
      else await $.store.delete(key)
    }
  } catch {
    // Start empty.
  }
  const ids = new Set(procs.map(p => p.id))
  procs = [...procs, ...loaded.filter(p => !ids.has(p.id))]
}

// Supervisors in the ledger with no record (a record lost to a crash): shown, and stoppable, as earlier jobs.
async function adoptFromLedger($: Engine, rows: PsRow[]): Promise<void> {
  let names: string[] = []
  try {
    names = (await $.fs.list(ledgerDir)).map(entry => entry.name)
  } catch {
    return
  }
  const known = new Set(procs.map(p => p.token))
  const now = await $.clock.now()
  // Candidates first, then the bound: exit records and temp files never crowd a live supervisor out, and a
  // `.run` whose supervisor is gone (left by one killed outright) is removed, so dead ones can't crowd it out either.
  const candidates = names.flatMap(name => {
    const m = name.match(/^([0-9a-f]{16,64})\.run$/)
    return m === null || known.has(m[1] as string) ? [] : [{ name, token: m[1] as string }]
  })
  let adopted = 0
  for (const { name, token } of candidates.slice(0, 2_000)) {
    if (adopted >= 200) break
    const led = parseLedger((await readFile($, `${ledgerDir}/${name}`)) ?? '')
    const row = led === null ? null : supervisorRow(rows, led.pid, led.lstart, token)
    if (led === null || row === null) {
      if (led !== null && !rows.some(r => r.pid === led.pid && r.lstart === led.lstart)) await removeLedger($, token)
      continue
    }
    adopted += 1
    counter += 1
    const line = commandOf(row.command)
    const cwd = await realDir($, led.cwd)
    // Every job the recovered line starts, each at the directory it runs in, for the duplicate check.
    const found = jobs(line, true)
    const planned: Planned[] = []
    for (const job of found) planned.push(await planAt($, line, job, cwd))
    const main = found.find(j => longRunner(j.text) !== null) ?? found[found.length - 1]
    procs.push({
      id: `ledger-${token.slice(0, 8)}-${counter}`, token, sessionId: 'earlier', command: display(main?.text ?? line),
      keys: planned.map(x => x.key), wants: planned.flatMap(x => (x.port === null ? [] : [x.port])), cwd, startedAt: Date.parse(led.lstart) || now, mode: led.mode === 'detached' ? 'detached' : 'task',
      supervisor: { pid: led.pid, lstart: led.lstart }, members: [], ports: [], status: 'running', cpu: 0, memMb: 0,
      exitCode: null, checkedAt: now, note: '',
    })
  }
}

// How a job whose supervisor is gone ended, and anything of its group left behind (shown, never signalled).
async function finish($: Engine, p: Proc, rows: PsRow[], stopped: boolean): Promise<void> {
  const ended = parseExit((await readFile($, `${ledgerDir}/${p.token}.exit`)) ?? '')
  p.exitCode = ended.code
  p.status = stopped || ended.how !== 'exited' ? 'stopped' : 'exited'
  const left = p.supervisor === null ? [] : groupMembers(rows, p.supervisor.pid)
  p.members = []
  p.ports = []
  p.cpu = 0
  p.memMb = 0
  p.note =
    left.length > 0
      ? `${left.length} process${left.length === 1 ? '' : 'es'} (pid ${left.map(r => r.pid).slice(0, 4).join(',')}) outlived the supervisor; Process Concierge does not signal them`
      : ended.how === 'killed'
        ? 'it ignored SIGTERM, so the supervisor used SIGKILL'
        : ''
}

// Re-check every live record: its supervisor, the group's ports, CPU and memory. A caller that already read the
// process table passes it in, so one tool call reads it once.
async function refresh($: Engine, rowsIn?: PsRow[] | null, portsIn?: Map<number, number[]>): Promise<void> {
  try {
    sessionId = await $.session.id()
  } catch {
    // Keep the last known id.
  }
  const now = await $.clock.now()
  for (const p of procs.filter(x => !alive(x) && now - x.checkedAt > KEEP_FINISHED_MS)) await forget($, p.id)
  const rows = rowsIn === undefined ? await psRows($) : rowsIn
  // A failed look changes nothing: absence is never inferred from a failed read.
  if (rows === null) return
  const ports = portsIn ?? (await listening($))
  const ours = new Set<number>()
  // The newest table: a second look taken for one record serves every record after it.
  let latest = rows
  for (const p of procs.filter(alive)) {
    let view = latest
    if (p.status === 'starting') {
      const led = parseLedger((await readFile($, `${ledgerDir}/${p.token}.run`)) ?? '')
      let row = led === null ? null : supervisorRow(view, led.pid, led.lstart, p.token)
      // The supervisor may have checked in after the table was read: look again before judging it gone.
      if (led !== null && row === null) {
        const fresh = await psRows($)
        if (fresh === null) continue
        latest = fresh
        view = fresh
        row = supervisorRow(view, led.pid, led.lstart, p.token)
      }
      if (led !== null && row !== null) {
        p.supervisor = { pid: led.pid, lstart: led.lstart }
        p.status = 'running'
      } else if (led !== null) {
        // It checked in and is already gone: a short job.
        p.supervisor = { pid: led.pid, lstart: led.lstart }
        await finish($, p, view, false)
      } else if ((await readFile($, `${ledgerDir}/${p.token}.exit`)) !== null) {
        // Checked in and finished between two looks: the supervisor removed its `.run` when it ended.
        await finish($, p, view, false)
      } else if (now - p.startedAt > CONFIRM_WITHIN_MS) {
        p.status = 'unsupervised'
        p.note = 'it ran without the supervisor (perl missing, or the group could not be created), so it has no stop button'
      }
    }
    if ((p.status === 'running' || p.status === 'stopping') && p.supervisor !== null) {
      const sup = supervisorRow(view, p.supervisor.pid, p.supervisor.lstart, p.token)
      if (sup === null) {
        // The stop workflow owns a stopping job's ending; a running one that vanished simply finished. A stop
        // whose settling timers were lost (a reload) is finished here once its supervisor is confirmed gone.
        if (p.status === 'running') await finish($, p, view, false)
        else if (now - (p.stopAt ?? 0) > STOP_ORPHANED_MS) await finish($, p, view, true)
      } else {
        const members = groupMembers(view, sup.pid)
        const pids = [sup.pid, ...members.map(r => r.pid)]
        for (const pid of pids) ours.add(pid)
        p.members = members.map(r => r.pid).slice(0, 50)
        p.ports = [...new Set(pids.flatMap(pid => ports.get(pid) ?? []))].sort((a, b) => a - b)
        p.cpu = Math.round(members.reduce((sum, r) => sum + r.cpu, 0) * 10) / 10
        p.memMb = Math.round(members.reduce((sum, r) => sum + r.rssKb, 0) / 1024)
      }
    }
    p.checkedAt = now
    await persist($, p)
  }
  const byPid = new Map(rows.map(r => [r.pid, r]))
  foreign = [...ports.entries()]
    .filter(([pid]) => !ours.has(pid))
    .slice(0, 8)
    .map(([pid, held]) => ({ pid, ports: held.slice(0, 4), command: short(display(byPid.get(pid)?.command ?? '?'), 80) }))
  await publish($)
}

// Ask a job's supervisor to stop its group. Nothing is signalled from here: the supervisor reads the stop file
// and signals the group it leads.
async function stopProc($: Engine, id: string): Promise<string> {
  const p = procs.find(x => x.id === id)
  if (p === undefined || p.status !== 'running' || p.supervisor === null) return 'not running'
  const rows = await psRows($)
  if (rows === null) {
    p.note = 'could not read the process list; nothing was asked to stop. Try again.'
    await publish($, p.note)
    return p.note
  }
  if (supervisorRow(rows, p.supervisor.pid, p.supervisor.lstart, p.token) === null) {
    await finish($, p, rows, false)
    await persist($, p)
    await publish($)
    return 'already gone'
  }
  try {
    await $.fs.write(`${ledgerDir}/${p.token}.stop`, 'stop\n')
  } catch (err) {
    p.note = `could not ask it to stop (${String(err).slice(0, 80)}); it is still running`
    await persist($, p)
    await publish($, p.note)
    return p.note
  }
  p.status = 'stopping'
  p.stopAt = await $.clock.now()
  p.note = ''
  await persist($, p)
  await publish($, `Stopping ${short(p.command, 40)}…`)
  SETTLE_MS.forEach((ms, i) => {
    $.clock.after(ms, () => {
      void settle($, id, i === SETTLE_MS.length - 1)
    })
  })
  return 'asked to stop'
}

// The stop workflow's own look: only here does a stopping job become stopped, or go back to running.
async function settle($: Engine, id: string, final: boolean): Promise<void> {
  const p = procs.find(x => x.id === id)
  if (p === undefined || p.status !== 'stopping' || p.supervisor === null) return
  const rows = await psRows($)
  if (rows === null) {
    if (final) {
      p.status = 'running'
      p.note = 'could not read the process list to confirm the stop; press stop again'
      await persist($, p)
      await publish($, p.note)
    }
    return
  }
  if (supervisorRow(rows, p.supervisor.pid, p.supervisor.lstart, p.token) !== null) {
    if (!final) return
    p.status = 'running'
    p.note = 'asked to stop, but it is still running; press stop again'
  } else {
    await finish($, p, rows, true)
  }
  await persist($, p)
  await publish($)
}

async function stopMany($: Engine, which: 'session' | 'orphans'): Promise<string> {
  const targets = procs.filter(p => p.status === 'running' && p.supervisor !== null && (which === 'session' ? p.sessionId === sessionId : p.sessionId !== sessionId))
  for (const p of targets) await stopProc($, p.id)
  return `${targets.length} asked to stop`
}

async function dismissFinished($: Engine): Promise<void> {
  for (const p of procs.filter(x => !alive(x))) await forget($, p.id)
  await publish($)
}

function describe(p: Proc): string {
  const pid = p.supervisor?.pid ?? '?'
  const ports = p.ports.length > 0 ? ` on ${p.ports.map(n => `:${n}`).join(' ')}` : ''
  return `${short(p.command, 100)}${ports} (supervisor pid ${pid}, started ${age(Date.now() - p.startedAt)} ago in ${p.cwd})`
}

function summary(list: Proc[]): string {
  const live = list.filter(p => p.status === 'running' || p.status === 'stopping')
  const head = live.length === 0 ? 'Process Concierge: no tracked jobs are running.' : `Process Concierge: ${live.length} running.`
  const lines = list.map(p => `- [${p.status}] ${describe(p)}${p.sessionId === sessionId ? '' : ' [earlier session]'}${p.note ? ` (${p.note})` : ''}`)
  const others = foreign.map(f => `- [not ours, shown only] pid ${f.pid} on ${f.ports.map(n => `:${n}`).join(' ')}: ${f.command}`)
  return [head, ...lines, ...others].join('\n')
}

type Planned = { text: string; index: number; list: number; dir: string; key: string; port: number | null; concurrent: boolean }

// What a new job would collide with: a listener or a reservation on the port it asks for, the same job
// already running in that folder, or an earlier job of the same command.
function conflictFor(x: Planned, listeners: Map<number, number[]>, rows: PsRow[] | null, now: number, ports: number[], earlier: Planned[]): string | null {
  const want = x.port
  if (want !== null) {
    if (ports.includes(want)) return `this command starts two things on port ${want} at once`
    for (const [pid, held] of listeners) {
      if (!held.includes(want)) continue
      const owner = procs.find(p => occupies(p, now) && (p.supervisor?.pid === pid || p.members.includes(pid)))
      if (owner !== undefined) return `port ${want} is already served by a job the agent started: ${describe(owner)}`
      const row = rows?.find(r => r.pid === pid)
      return `port ${want} is already in use by pid ${pid}${row ? ` (${short(display(row.command), 60)})` : ''}, which was not started through Process Concierge`
    }
    const reserving = procs.find(p => occupies(p, now) && (p.wants.includes(want) || p.ports.includes(want)))
    if (reserving !== undefined) return `port ${want} is taken by a server the agent just started in ${reserving.cwd}, which is still coming up`
  }
  if (earlier.some(y => y.key === x.key && (x.port === null || y.port === null || x.port === y.port))) return 'this command starts the same job twice at once'
  for (const p of procs) {
    if (!occupies(p, now) || !p.keys.includes(x.key)) continue
    if (x.port !== null && !p.wants.includes(x.port) && !p.ports.includes(x.port)) continue
    return p.status === 'starting'
      ? `the same command was just started in ${p.cwd} and is still coming up`
      : `this is already running: ${describe(p)}`
  }
  return null
}

function newProc(x: Planned, also: Planned[], now: number, token: string, mode: Mode, supervised: boolean): Proc {
  counter += 1
  const wants = [x, ...also].flatMap(y => (y.port === null ? [] : [y.port]))
  return {
    id: `${sessionId.slice(0, 8)}-${now}-${counter}`, token, sessionId, command: display(x.text),
    keys: [x.key, ...also.map(y => y.key)], wants,
    cwd: x.dir, startedAt: now, mode, supervisor: null, members: [], ports: [],
    status: supervised ? 'starting' : 'unsupervised', cpu: 0, memMb: 0, exitCode: null, checkedAt: now,
    note: supervised ? '' : 'started in shell syntax Process Concierge does not split safely, so it is shown without a stop button',
  }
}

// A job of `cmd`, at the directory it runs in when `cmd` starts in `cwd`.
async function planAt($: Engine, cmd: string, job: Job, cwd: string): Promise<Planned> {
  const dir = await realDir($, startDir(cmd, job.index, cwd, home))
  return { text: job.text, index: job.index, list: job.list, dir, key: await digest(`${dir}\u0000${identity(job.text)}`), port: requestedPort(job.text), concurrent: job.concurrent }
}

// After a call returns with jobs left running: look for their supervisors now and a few more times.
async function track($: Engine, ids: string[], taskId: string | undefined): Promise<string> {
  for (const p of procs.filter(x => ids.includes(x.id))) p.taskId = taskId
  await refresh($)
  for (const ms of RETRIES_MS) {
    $.clock.after(ms, () => {
      void refresh($)
    })
  }
  const mine = procs.filter(x => ids.includes(x.id))
  const supervised = mine.filter(x => x.status !== 'unsupervised')
  return (
    `Process Concierge is tracking ${mine.length === 1 ? 'this background job' : `${mine.length} background jobs`}` +
    (supervised.length > 0 ? ' (run under its supervisor, bin/pc-run, so the user can stop it from /procs)' : '') +
    `. Before starting it again, check whether it is still running.`
  )
}

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
  home = (await $.env.get('HOME')) ?? ''
  ledgerDir = home === '' ? '' : `${home}/.cache/process-concierge/ledger`
  const userShell = (await $.env.get('SHELL')) ?? ''
  shell = /^\/[\w/.-]*\/(zsh|bash)$/.test(userShell) ? userShell : '/bin/sh'
  // The supervisor needs perl (to lead a process group) and env (to start it clean); without them nothing is
  // rewritten, and jobs are shown without a stop button.
  const ready = (await exists($, '/usr/bin/perl')) && (await exists($, '/usr/bin/env')) && (await exists($, '/bin/ps'))
  script = ready ? `${$.plugin.root}/bin/pc-run` : ''
  await loadStore($)
  // A stop under way when the module last loaded: resume judging it.
  for (const p of procs.filter(x => x.status === 'stopping')) {
    $.clock.after(SETTLE_MS[0] as number, () => {
      void settle($, p.id, true)
    })
  }
  const rows = await psRows($)
  if (rows !== null && ledgerDir !== '') await adoptFromLedger($, rows)
  await refresh($, rows)
  await startTicker($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'procs',
        description: 'Process Concierge: show the jobs the agent started, with ports and stop buttons',
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

  // The permission decision for a command this mod rewrote is the decision for the command the model asked for.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const input = (e.input ?? {}) as Record<string, unknown>
    const saved = typeof input.command === 'string' ? rewrites.get(input.command) : undefined
    // Only exactly the call this mod rewrote, every other argument unchanged, is answered for the original.
    if (saved === undefined || !sameArgs(input, saved.rewritten)) return next(e)
    return $.tool.check({ tool: 'Bash', input: saved.original })
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String(e.command ?? '')
    const background = e.run_in_background === true
    if (!background && longRunner(cmd) === null && !detaches(cmd)) return next(e)
    if (ledgerDir === '') return next(e)

    const ids: string[] = []
    let command = cmd
    try {
      const rows = await psRows($)
      const listeners = await listening($)
      await refresh($, rows, listeners)
      // Without the supervisor's tools, nothing is rewritten: every job is shown without a stop button.
      const wrapped = script === '' ? { command: cmd, jobs: [], unsafe: jobs(cmd, background) } : wrap(cmd, background, script, ledgerDir, shell, newToken)
      const cwd = await $.session.cwd()
      const planned: { x: Planned; also: Planned[]; token: string; mode: Mode; supervised: boolean }[] = []
      const all = jobs(cmd, background)
      for (const job of wrapped.jobs) {
        const also: Planned[] = []
        for (const extra of job.also) also.push(await planAt($, cmd, extra, cwd))
        const own = all.find(j => j.index === job.index) ?? { text: job.text, index: job.index, concurrent: false, list: 0 }
        planned.push({ x: await planAt($, cmd, own, cwd), also, token: job.token, mode: job.mode, supervised: true })
      }
      for (const job of wrapped.unsafe) planned.push({ x: await planAt($, cmd, job, cwd), also: [], token: newToken(), mode: 'detached', supervised: false })
      const now = await $.clock.now()
      // From here to the reservation there is no await: check and reserve are one step. Within this one command
      // a job collides only with an earlier one still running beside it: one whose shell list was sent to the
      // background with `&` (`npm run dev || npm run dev` starts the second only if the first failed).
      // Jobs of one shell list run one after another (`a || b`); a later list runs beside an earlier one only if
      // that earlier list was sent to the background. So each job is checked against the jobs of earlier
      // backgrounded lists, and a list's own jobs are added only after the whole list is checked.
      const ports: number[] = []
      const earlier: Planned[] = []
      const inOrder = planned.flatMap(({ x, also }) => [x, ...also]).sort((a, b) => a.index - b.index)
      const lists = [...new Set(inOrder.map(y => y.list))]
      for (const list of lists) {
        const members = inOrder.filter(y => y.list === list)
        for (const y of members) {
          const conflict = conflictFor(y, listeners, rows, now, ports, earlier)
          if (conflict !== null) {
            return {
              deny:
                `Process Concierge: not started, because ${conflict}. ` +
                `Reuse the running one. If it really must restart, the user can stop it in /procs first.`,
            }
          }
        }
        for (const y of members.filter(z => z.concurrent)) {
          if (y.port !== null) ports.push(y.port)
          earlier.push(y)
        }
      }
      for (const { x, also, token, mode, supervised } of planned) {
        const p = newProc(x, also, now, token, mode, supervised)
        procs.push(p)
        ids.push(p.id)
      }
      if (wrapped.command !== cmd) {
        const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...args } = e as unknown as Record<string, unknown>
        rewrites.set(wrapped.command, { original: args, rewritten: { ...args, command: wrapped.command } })
        command = wrapped.command
      }
    } catch {
      // Tracking is best effort; the command always runs, unwrapped if wrapping failed.
      command = cmd
    }

    let ran: ToolCallResult
    try {
      ran = await next(command === cmd ? e : { ...e, command })
    } finally {
      rewrites.delete(command)
    }
    try {
      const result = ran.result as BashResult
      const backgrounded = ran.deny === undefined && result?.backgroundTaskId !== undefined && result.backgroundEndsWithFinalResponse !== true
      // A detached job outlives the call; a task-mode job does only when the call itself went to the background.
      const keep = (p: Proc) => ran.deny === undefined && (backgrounded || p.mode === 'detached')
      for (const id of ids) {
        const p = procs.find(x => x.id === id)
        if (p !== undefined && !keep(p)) await forget($, id)
      }
      const kept = ids.filter(id => procs.some(x => x.id === id))
      if (kept.length === 0) {
        await publish($)
        return ran
      }
      return withNote(ran, await track($, kept, result?.backgroundTaskId))
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
    const others = value?.foreign ?? []
    const now = value?.updatedAt ?? 0
    const cols = Math.max(40, e.props.bodyColumns ?? 80)
    const stoppable = (p: Proc) => p.status === 'running' && p.supervisor !== null
    const mine = list.filter(p => stoppable(p) && p.sessionId === value?.sessionId).length
    const orphans = list.filter(p => stoppable(p) && p.sessionId !== value?.sessionId).length
    const finished = list.filter(p => !alive(p)).length
    return (
      <Box flexDirection="column">
        <Box>
          <Button key="refresh" label="refresh" onPress={() => refresh($)} />
          {mine > 0 ? <Button key="stop-all" label={`stop all from this session (${mine})`} onPress={() => stopMany($, 'session')} /> : null}
          {orphans > 0 ? <Button key="clean" label={`stop earlier sessions' jobs (${orphans})`} onPress={() => stopMany($, 'orphans')} /> : null}
          {finished > 0 ? <Button key="dismiss" label="clear finished" onPress={() => dismissFinished($)} /> : null}
        </Box>
        {value?.note ? <Text dimColor>{value.note}</Text> : null}
        {list.length === 0 ? <Text dimColor>Nothing tracked yet. Background jobs the agent starts show up here.</Text> : null}
        {list.map(p => {
          const glyph = p.status === 'running' ? '●' : p.status === 'starting' ? '◌' : p.status === 'stopping' ? '◐' : '○'
          const ports = p.ports.length > 0 ? p.ports.map(n => `:${n}`).join(' ') : 'no port'
          const who = p.sessionId === value?.sessionId ? '' : ' · earlier session'
          const code = p.exitCode !== null && !alive(p) ? ` · exit ${p.exitCode}` : ''
          return (
            <Box key={p.id} flexDirection="column" marginTop={1}>
              <Text color={p.status === 'running' ? 'green' : undefined} dimColor={p.status !== 'running'}>
                {glyph} {short(p.command, cols - 12)}
              </Text>
              <Text dimColor>
                {'  '}{ports} · {p.status}{code} {age(now - p.startedAt)} · {p.members.length} proc · {p.cpu}% cpu · {p.memMb} MB{who}
              </Text>
              {p.note ? <Text color="yellow">{'  '}{short(p.note, cols - 4)}</Text> : null}
              <Box>
                <Text dimColor>{'  '}{short(p.cwd, cols - 16)} </Text>
                {stoppable(p) ? <Button key={`stop-${p.id}`} label="stop" onPress={() => stopProc($, p.id)} /> : null}
              </Box>
            </Box>
          )
        })}
        {others.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>Other listeners (not started through Process Concierge, shown only):</Text>
            {others.map(f => (
              <Text key={`f-${f.pid}`} dimColor>
                {'  '}pid {f.pid} · {f.ports.map(n => `:${n}`).join(' ')} · {short(f.command, cols - 24)}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}

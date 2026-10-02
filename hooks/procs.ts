// Pure helpers: reading shell commands, `ps` and `lsof` output. No engine calls here.

export type PsRow = { pid: number; ppid: number; cpu: number; rssKb: number; lstart: string; command: string }
export type Ident = { pid: number; lstart: string }
// What a process's environment says about who started it; `visible` is false when the OS hides it.
export type EnvInfo = { visible: boolean; claudePid?: number; sessionId?: string }

const PM_SCRIPT = '(dev|start|serve|watch|preview|storybook)(:[\\w.-]+)?(?=$|\\s)'

// Programs that keep running until stopped: dev servers, watchers, bundlers.
const LONG_RUNNERS: RegExp[] = [
  new RegExp(`^(npm|pnpm|yarn|bun) (run )?${PM_SCRIPT}`),
  /^(vite|nuxt dev|astro dev|remix dev|gatsby develop|ng serve|vue-cli-service serve)(?=$|\s)/, /^next (dev|start)(?=$|\s)/,
  /^(expo start|react-native start|metro)(?=$|\s)/,
  /^webpack (serve|--watch|-w)(?=$|\s)/, /^webpack-dev-server(?=$|\s)/,
  /^tsc\b.*(\s-w(?=$|\s)|--watch)/, /^(jest|vitest)\b.*(\s--watch|\s-w(?=$|\s)|--watchAll)/, /^vitest$/, /^vitest (dev|watch)(?=$|\s)/,
  /^nodemon(?=$|\s)/, /^ts-node-dev(?=$|\s)/, /^tsx watch(?=$|\s)/, /^node\b.*\s--watch(?=$|\s)/,
  /^(rails (s|server)|bin\/rails (s|server))(?=$|\s)/,
  /^python[0-9.]* -m http\.server(?=$|\s)/, /^(uvicorn|gunicorn|hypercorn)(?=$|\s)/, /^(flask run|python[0-9.]* manage\.py runserver)(?=$|\s)/,
  /^docker( |-)compose (up|watch)(?=$|\s)/, /^(http-server|serve|live-server|browser-sync)(?=$|\s)/,
  /^cargo (watch|run)(?=$|\s)/, /^(air|reflex)(?=$|\s)/, /^go run(?=$|\s)/, /^(hugo server|jekyll serve|mkdocs serve)(?=$|\s)/,
]

// Wrappers that start the real program, and which of their flags take an operand.
const WRAPPERS: Record<string, Set<string>> = {
  nohup: new Set(), setsid: new Set(), exec: new Set(), command: new Set(), caffeinate: new Set(['-t', '-w']),
  time: new Set(['-o']), nice: new Set(['-n']), env: new Set(['-u', '-C', '-S', '-P']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U']),
}
const RUNNERS = new Set(['npx', 'bunx'])
const RUNNER_VALUE_FLAGS = new Set(['--package', '-p', '--call', '-c'])
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
// Package-manager flags placed before the script that take an operand.
const PM_VALUE_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd', '--filter', '-F', '--workspace', '-w', '--loglevel'])
// Package-manager flags that change the directory the script runs in.
const PM_DIR_FLAGS = new Set(['--prefix', '-C', '--dir', '--cwd'])
// Programs whose first positional is a subcommand, so the next positional also identifies the job.
const SUBCOMMANDS = new Set(['go', 'cargo', 'docker', 'docker-compose', 'rails', 'flask', 'hugo', 'jekyll', 'mkdocs', 'tsx', 'vitest', 'webpack'])
// Programs whose -p means a remote port, not a local listen port.
const REMOTE_PORT_PROGRAMS = new Set(['ssh', 'scp', 'sftp', 'rsync', 'mosh', 'psql', 'mysql', 'redis-cli'])
// Flags of the programs themselves that take a separate operand, so the operand is not the program's identity.
const VALUE_FLAGS = new Set([
  '--port', '-p', '--host', '-H', '--config', '-c', '--mode', '--prefix', '-C', '--filter', '-F', '--cwd', '--dir',
  '--bind', '-b', '--listen', '-l', '--env', '-e', '--app', '--workspace', '-w',
])

// Blank out quoted text (keeping length) so operators inside quotes are never read as shell syntax.
export function unquote(cmd: string): string {
  let out = ''
  let quote = ''
  for (const c of cmd) {
    if (quote !== '') {
      out += c === quote ? c : ' '
      if (c === quote) quote = ''
    } else {
      if (c === '"' || c === "'") quote = c
      out += c
    }
  }
  return out
}

// `list` numbers the shell lists (separated by `;`, `&` and newlines): a list ended by `&` runs in a
// background subshell, so a `cd` inside it never reaches the lists after it.
export type Segment = { text: string; background: boolean; list: number; listBackground: boolean }

// Split a command line into simple commands on &&, ||, ;, |, & and newlines, outside quotes.
// `background` marks the ones a single `&` sends to the background.
export function segments(cmd: string): Segment[] {
  const mask = unquote(cmd)
  const out: Segment[] = []
  let start = 0
  let list = 0
  const push = (end: number, background: boolean, endsList: boolean) => {
    const text = cmd.slice(start, end).trim()
    if (text !== '') out.push({ text, background, list, listBackground: false })
    if (endsList) {
      for (const s of out) if (s.list === list) s.listBackground = background
      list += 1
    }
  }
  for (let i = 0; i < mask.length; i += 1) {
    const c = mask[i]
    const two = mask.slice(i, i + 2)
    if (two === '&&' || two === '||' || two === '|&') {
      push(i, false, false)
      i += 1
      start = i + 1
    } else if (c === '&' && mask[i - 1] !== '>' && mask[i + 1] !== '>') {
      push(i, true, true)
      start = i + 1
    } else if (c === ';' || c === '\n') {
      push(i, false, true)
      start = i + 1
    } else if (c === '|') {
      push(i, false, false)
      start = i + 1
    }
  }
  push(mask.length, false, true)
  return out
}

const strip = (w: string) => w.replace(/^["']|["']$/g, '')

// The words of a simple command with env assignments, redirects, wrappers, runner and package-manager
// flags (and their operands) removed.
export function words(segment: string): string[] {
  const raw = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  const out: string[] = []
  let wrapper: Set<string> | null = null
  for (let i = 0; i < raw.length; i += 1) {
    const w = raw[i] as string
    if (/^\d*[<>]/.test(w)) {
      if (/^\d*[<>]+&?$/.test(w)) i += 1
      continue
    }
    if (out.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue
    if (out.length === 0 && Object.hasOwn(WRAPPERS, w)) {
      wrapper = WRAPPERS[w] ?? null
      continue
    }
    if (out.length === 0 && w.startsWith('-')) {
      if (wrapper !== null && wrapper.has(w)) i += 1
      continue
    }
    // Runner flags (`npx --yes vite`) and package-manager flags before the script (`npm --prefix web run dev`).
    const first = out[0] === undefined ? '' : base(out[0])
    if (out.length === 1 && w.startsWith('-') && RUNNERS.has(first)) {
      if (RUNNER_VALUE_FLAGS.has(w)) i += 1
      continue
    }
    if (out.length === 1 && w.startsWith('-') && PACKAGE_MANAGERS.has(first)) {
      if (PM_VALUE_FLAGS.has(w)) i += 1
      continue
    }
    out.push(strip(w))
  }
  if (out.length > 1 && RUNNERS.has(base(out[0] as string))) out.shift()
  if (out.length > 2 && PACKAGE_MANAGERS.has(out[0] as string) && (out[1] === 'exec' || out[1] === 'dlx')) out.splice(0, 2)
  return out
}

export const base = (w: string) => (w.split('/').pop() ?? w).replace(/\.(m?js|cjs|ts|py)$/, '')

function shape(segment: string): string {
  return words(segment).map((w, i) => (i === 0 ? base(w) : w)).join(' ')
}

export function isLongRunner(segment: string): boolean {
  const s = shape(segment)
  // A detached compose/run exits at once: the containers are docker's, not a process this mod can stop.
  if (/^docker( |-)compose (up|start)\b/.test(s) && /(^|\s)(-d|--detach)(?=$|\s)/.test(s)) return false
  return LONG_RUNNERS.some(re => re.test(s))
}

// The simple command that starts the long-running program, if any.
export function longRunner(cmd: string): string | null {
  for (const s of segments(cmd)) if (isLongRunner(s.text)) return s.text
  return null
}

// True when the command sends something to the background: a single `&`, or nohup/setsid/disown as a command.
export function detaches(cmd: string): boolean {
  for (const s of segments(cmd)) {
    if (s.background) return true
    const first = (s.text.match(/\S+/) ?? [''])[0]
    if (first === 'nohup' || first === 'setsid' || first === 'disown') return true
  }
  return false
}

export type Job = { text: string; index: number }

const NOT_A_JOB = /^(cd|pushd|popd|export|set|source|\.)(\s|$)/

// The segments a command launches that need tracking: each backgrounded or detached one, each long runner,
// and for a backgrounded tool call the last real command. `index` is the segment's position, so two identical
// commands in different folders stay two jobs.
export function jobs(cmd: string, wholeInBackground: boolean): Job[] {
  const segs = segments(cmd).map((s, index) => ({ ...s, index })).filter(s => !NOT_A_JOB.test(s.text))
  const picked = segs.filter(s => s.background || isLongRunner(s.text) || /^(nohup|setsid)\s/.test(s.text))
  if (picked.length === 0 && wholeInBackground && segs.length > 0) picked.push(segs[segs.length - 1] as (typeof segs)[number])
  return picked.map(s => ({ text: s.text, index: s.index }))
}

// A port the segment asks for on its command line (not through PORT=): the process shows it there too.
function argvPort(segment: string): number | null {
  const ws = words(segment)
  if (ws.length === 0 || REMOTE_PORT_PROGRAMS.has(base(ws[0] as string))) return null
  const text = ws.join(' ')
  const pats = [
    /(?:^|\s)--port[= ](\d{2,5})(?=$|\s)/, /(?:^|\s)-p[= ]?(?:[\d.]+:)?(\d{2,5})(?::\d+)?(?=$|\s)/,
    /http\.server\s+(\d{2,5})(?=$|\s)/, /(?:^|\s)--listen[= ](?:\S*:)?(\d{2,5})(?=$|\s)/,
    /(?:^|\s)(?:--bind|-b)[= ]?\S*:(\d{2,5})(?=$|\s)/, /(?:^|\s)runserver\s+(?:\S*:)?(\d{2,5})(?=$|\s)/,
  ]
  for (const re of pats) {
    const m = text.match(re)
    if (m !== null) {
      const n = Number(m[1])
      if (n > 0 && n < 65536) return n
    }
  }
  return null
}

// A port the segment asks for, when it names one (command line, or a PORT= assignment).
export function requestedPort(segment: string): number | null {
  const fromArgv = argvPort(segment)
  if (fromArgv !== null) return fromArgv
  const ws = words(segment)
  if (ws.length > 0 && REMOTE_PORT_PROGRAMS.has(base(ws[0] as string))) return null
  const m = segment.match(/(?:^|\s)PORT=(\d{2,5})(?=$|\s)/)
  const n = m === null ? 0 : Number(m[1])
  return n > 0 && n < 65536 ? n : null
}

// Words a matching process's command line must contain: the program, what identifies its job, and the port
// it was given on its command line.
export function matchWords(segment: string): string[] {
  const ws = words(segment)
  if (ws.length === 0) return []
  const prog = base(ws[0] as string)
  const out = [prog]
  const rest = ws.slice(1)
  const wanted = SUBCOMMANDS.has(prog) ? 2 : 1
  let found = 0
  for (let i = 0; i < rest.length && found < wanted; i += 1) {
    const w = rest[i] as string
    // Package managers: `npm run dev` and `npm dev` both show the script name.
    if (PACKAGE_MANAGERS.has(prog) && (w === 'run' || w === 'run-script')) continue
    if (w === '-m') {
      const mod = rest[i + 1]
      if (mod !== undefined) out.push(mod)
      break
    }
    if (w === '--') break
    if (w.startsWith('-')) {
      if (VALUE_FLAGS.has(w) && rest[i + 1] !== undefined) i += 1
      continue
    }
    if (/^\d+$/.test(w)) continue
    out.push(base(w))
    found += 1
  }
  const port = PACKAGE_MANAGERS.has(prog) ? null : argvPort(segment)
  if (port !== null) out.push(String(port))
  return out
}

// What counts as "the same job" for the duplicate check, before the folder: the package script whatever the
// package manager and flags, or the program and its identifying words without the port.
export function identity(segment: string): string {
  const ws = words(segment)
  if (ws.length === 0) return ''
  const prog = base(ws[0] as string)
  if (PACKAGE_MANAGERS.has(prog)) {
    const script = ws.slice(1).find(w => w !== 'run' && w !== 'run-script' && !w.startsWith('-'))
    return `pkg ${script ?? ''}`
  }
  const port = argvPort(segment)
  return matchWords(segment).filter(w => port === null || w !== String(port)).join(' ')
}

const SECRET_FLAG = /(--?[\w-]*(?:token|secret|password|passwd|pass|key|auth|credential)[\w-]*)([= ])("[^"]*"|'[^']*'|\S+)/gi
const SECRET_ENV = /\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|CREDENTIAL)[A-Za-z_]*)=("[^"]*"|'[^']*'|\S+)/gi

// Hide secret-looking flag values, assignments and URL passwords, quoted values included.
export function redact(text: string): string {
  return text
    .replace(SECRET_FLAG, '$1$2…')
    .replace(SECRET_ENV, '$1=…')
    .replace(/(\w+:\/\/[^\s:/@]+):[^\s@/]+@/g, '$1:…@')
}

// The env-free text of a segment, with secrets hidden.
export function display(segment: string): string {
  const ws = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  let i = 0
  while (i < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[i] as string)) i += 1
  return redact(ws.slice(i).join(' ')).slice(0, 300)
}

// Normalise a path: collapse `.`, `..` and duplicate or trailing slashes.
export function normalize(path: string): string {
  const abs = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${abs ? '/' : ''}${parts.join('/')}` || '/'
}

function resolveDir(dir: string, target: string, home: string): string {
  let t = strip(target)
  if (t === '~' || t.startsWith('~/')) t = home + t.slice(1)
  return normalize(t.startsWith('/') ? t : `${dir}/${t}`)
}

// The directory the segment at `index` runs in: every `cd`/`pushd` before it, applied in order, then any
// directory its own `env -C` or package-manager `--prefix`/`-C`/`--dir`/`--cwd` names.
export function startDir(cmd: string, index: number, cwd: string, home: string): string {
  let dir = normalize(cwd)
  const segs = segments(cmd)
  const target = segs[index]
  for (let i = 0; i < index && i < segs.length; i += 1) {
    const seg = segs[i] as Segment
    // A `cd` in an earlier list that ran in the background changed only that subshell's folder.
    if (seg.list !== target?.list && seg.listBackground) continue
    const m = seg.text.match(/^(cd|pushd)\s+("[^"]+"|'[^']+'|\S+)\s*$/)
    if (m !== null) dir = resolveDir(dir, m[2] as string, home)
  }
  const own = segs[index]?.text ?? ''
  const raw = own.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  for (let i = 0; i < raw.length - 1; i += 1) {
    const w = raw[i] as string
    const prev = raw[i - 1]
    if (w === '-C' && (prev === 'env' || raw.slice(0, i).includes('env'))) dir = resolveDir(dir, raw[i + 1] as string, home)
    else if (PM_DIR_FLAGS.has(w) && raw.slice(0, i).some(x => PACKAGE_MANAGERS.has(base(x)))) dir = resolveDir(dir, raw[i + 1] as string, home)
  }
  return dir
}

const LSTART = /^([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/

// `LC_ALL=C ps -axww -o pid=,ppid=,pcpu=,rss=,lstart=,command=`
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
    if (m === null) continue
    const rest = (m[5] as string).match(LSTART)
    if (rest === null) continue
    rows.push({
      pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]),
      lstart: (rest[1] as string).replace(/\s+/g, ' '), command: rest[2] as string,
    })
  }
  return rows
}

// `ps -E -ww -o pid=,command= -p …`: the environment follows the command where the OS shows it.
export function parseEnv(text: string): Map<number, EnvInfo> {
  const out = new Map<number, EnvInfo>()
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (m === null) continue
    const toks = (m[2] as string).split(/\s+/)
    const info: EnvInfo = { visible: toks.some(t => /^PATH=\//.test(t)) && toks.some(t => /^HOME=\//.test(t)) }
    for (const t of toks) {
      const pid = t.match(/^CLAUDE_PID=(\d+)$/)
      if (pid !== null) info.claudePid = Number(pid[1])
      const sid = t.match(/^CLAUDE_CODE_SESSION_ID=([\w-]+)$/)
      if (sid !== null) info.sessionId = sid[1] as string
    }
    out.set(Number(m[1]), info)
  }
  return out
}

// `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: pid -> listening ports.
export function parseLsof(text: string): Map<number, number[]> {
  const out = new Map<number, number[]>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0) {
      const m = line.match(/:(\d+)$/)
      if (m === null) continue
      const list = out.get(pid) ?? []
      const port = Number(m[1])
      if (!list.includes(port)) list.push(port)
      out.set(pid, list)
    }
  }
  return out
}

// `lsof -a -d cwd -Fpn -p …`: pid -> working directory.
export function parseCwds(text: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0) out.set(pid, line.slice(1))
  }
  return out
}

// Every process below `pid`.
export function descendants(rows: PsRow[], pid: number): number[] {
  const kids = new Map<number, number[]>()
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid])
  const out: number[] = []
  const queue = [...(kids.get(pid) ?? [])]
  while (queue.length > 0 && out.length < 500) {
    const p = queue.shift() as number
    if (out.includes(p)) continue
    out.push(p)
    queue.push(...(kids.get(p) ?? []))
  }
  return out
}

// True when `pid` has `ancestor` somewhere above it.
export function descendsFrom(rows: PsRow[], pid: number, ancestor: number): boolean {
  if (ancestor <= 1) return false
  const parent = new Map(rows.map(r => [r.pid, r.ppid]))
  let cur = parent.get(pid)
  for (let i = 0; i < 64 && cur !== undefined && cur > 1; i += 1) {
    if (cur === ancestor) return true
    cur = parent.get(cur)
  }
  return false
}

// Whole-token match: each word must equal some token's base name (`vite` matches `/x/vite.js`, not `vitest`).
export function commandMatches(commandLine: string, match: string[]): boolean {
  if (match.length === 0) return false
  const toks = commandLine.split(/\s+/).filter(t => t !== '').map(base)
  return match.every(w => toks.includes(base(w)))
}

const OWN_TOOLS = /^(ps|lsof|kill|sh)$/

// The top of each tree in `pool`: processes whose parent is not also in it, minus this mod's own tools.
export function roots(pool: PsRow[]): PsRow[] {
  const ids = new Set(pool.map(r => r.pid))
  return pool.filter(r => !ids.has(r.ppid) && !OWN_TOOLS.test(base(r.command.split(/\s+/)[0] ?? '')))
}

// The processes that appeared and match: only the top of each matching tree.
export function newRoots(before: Set<number>, after: PsRow[], match: string[]): PsRow[] {
  return roots(after.filter(r => !before.has(r.pid) && commandMatches(r.command, match)))
}

// The members of a recorded tree that are still the same process (same pid and start time).
export function stillOurs(tree: Ident[], rows: PsRow[]): Ident[] {
  const byPid = new Map(rows.map(r => [r.pid, r]))
  return tree.filter(x => x.lstart !== '' && byPid.get(x.pid)?.lstart === x.lstart)
}

// The shell script that signals each `pid:lstart` only if that pid still has that start time at the moment
// of the signal, and prints the pids it signalled. The window between the check and the kill is the script's
// own two commands, not a round trip through the hook.
export const SIGNAL_SCRIPT =
  'sig=$1; shift; for spec in "$@"; do pid=${spec%%:*}; want=${spec#*:}; ' +
  'now=$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | tr -s " " | sed "s/^ //;s/ $//"); ' +
  '[ -n "$now" ] && [ "$now" = "$want" ] && kill "-$sig" "$pid" 2>/dev/null && echo "$pid"; done; exit 0'

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d`
}

export function short(text: string, room: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > room ? `${line.slice(0, Math.max(1, room - 1))}…` : line
}

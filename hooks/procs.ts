// Pure helpers: reading shell commands, wrapping jobs in the supervisor, and reading `ps`, `lsof` and ledger
// output. No engine calls here.

export type PsRow = { pid: number; ppid: number; pgid: number; cpu: number; rssKb: number; lstart: string; command: string }

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
export type Segment = { text: string; background: boolean; list: number; listBackground: boolean; start: number; end: number }

// Split a command line into simple commands on &&, ||, ;, |, & and newlines, outside quotes.
// `background` marks the ones a single `&` sends to the background.
export function segments(cmd: string): Segment[] {
  const mask = unquote(cmd)
  const out: Segment[] = []
  let start = 0
  let list = 0
  const push = (end: number, background: boolean, endsList: boolean) => {
    const raw = cmd.slice(start, end)
    const text = raw.trim()
    const lead = raw.length - raw.trimStart().length
    if (text !== '') out.push({ text, background, list, listBackground: false, start: start + lead, end: start + lead + text.length })
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

// `concurrent`: the job's shell list was sent to the background, so what follows it runs at the same time.
export type Job = { text: string; index: number; concurrent: boolean; list: number }

const NOT_A_JOB = /^(cd|pushd|popd|export|set|source|\.)(\s|$)/

// The segments a command launches that need tracking: each backgrounded or detached one, each long runner,
// and for a backgrounded tool call the last real command. `index` is the segment's position, so two identical
// commands in different folders stay two jobs.
export function jobs(cmd: string, wholeInBackground: boolean): Job[] {
  const segs = segments(cmd).map((s, index) => ({ ...s, index })).filter(s => !NOT_A_JOB.test(s.text))
  const picked = segs.filter(s => s.background || isLongRunner(s.text) || /^(nohup|setsid)\s/.test(s.text))
  if (picked.length === 0 && wholeInBackground && segs.length > 0) picked.push(segs[segs.length - 1] as (typeof segs)[number])
  return picked.map(s => ({ text: s.text, index: s.index, concurrent: s.listBackground, list: s.list }))
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
      if ((VALUE_FLAGS.has(w) || SECRET_NAME.test(w)) && !w.includes('=') && rest[i + 1] !== undefined) i += 1
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

const SECRET_NAME = /token|secret|password|passwd|pass|key|auth|credential/i
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

// `LC_ALL=C ps -axww -o pid=,ppid=,pgid=,pcpu=,rss=,lstart=,command=`
export function parsePs(text: string): PsRow[] {
  const rows: PsRow[] = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
    if (m === null) continue
    const rest = (m[6] as string).match(LSTART)
    if (rest === null) continue
    rows.push({
      pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cpu: Number(m[4]), rssKb: Number(m[5]),
      lstart: (rest[1] as string).replace(/\s+/g, ' '), command: rest[2] as string,
    })
  }
  return rows
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

// ---- The supervisor -------------------------------------------------------------------------------------

export type Mode = 'task' | 'detached'

// Single-quote a word for /bin/sh.
export function q(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`
}

export const TOKEN = /^[0-9a-f]{16,64}$/

// The command line that runs `command` under the supervisor script, in `shell` (the shell the Bash tool uses).
export function supervised(script: string, token: string, ledger: string, mode: Mode, shell: string, command: string): string {
  return `/bin/sh ${q(script)} ${token} ${q(ledger)} ${mode} ${q(shell)} -- ${q(command)}`
}

// Shell syntax this mod does not split safely: a job inside it is left as it is (and shown without a stop button).
const UNSAFE = /[(){}`]|\$\(|<<|(^|[;&|]\s*)(if|then|else|elif|fi|for|while|until|do|done|case|esac|function)\b/

// The text with single-quoted spans blanked: what `$` expansions remain live.
function withoutSingleQuotes(text: string): string {
  let out = ''
  let quote = ''
  for (const c of text) {
    if (quote === "'") {
      out += c === "'" ? c : ' '
      if (c === "'") quote = ''
    } else {
      if (quote === '' && c === "'") quote = "'"
      else if (c === '"') quote = quote === '"' ? '' : '"'
      out += c
    }
  }
  return out
}

// Lexical constructs this mod does not split safely: an unquoted `#` comment, or any backslash escape.
export function lexicallyUnsafe(cmd: string): boolean {
  if (cmd.includes('\\')) return true
  return /(^|[\s;&|])#/.test(unquote(cmd))
}

export type Wrapped = { text: string; index: number; token: string; mode: Mode; also: Job[] }
export type Wrap = { command: string; jobs: Wrapped[]; unsafe: Job[] }

// Rewrite a command so the job it starts runs under the supervisor, without ever splitting the command line:
// - a run-in-background call is wrapped whole, so the user's shell runs the original text unchanged (task mode:
//   the background task lasts as long as everything it started);
// - a foreground call is wrapped only when it is exactly one simple command, optionally sent to the background
//   with one trailing `&` (detached). Anything else (several commands, comments, escapes, subshells, groups,
//   substitutions, heredocs, control keywords, `exec`, `setsid`) is left untouched and shown without a stop button.
export function wrap(cmd: string, wholeInBackground: boolean, script: string, ledger: string, shell: string, token: () => string): Wrap {
  const picked = jobs(cmd, wholeInBackground)
  if (picked.length === 0) return { command: cmd, jobs: [], unsafe: [] }
  const untouched = { command: cmd, jobs: [], unsafe: picked }
  // `setsid` as a word anywhere, by path too, and inside double quotes (a `bash -c "setsid …"`).
  if (/(^|[\s;&|("])(\S*\/)?setsid(?=$|[\s;&|)"])/.test(withoutSingleQuotes(cmd))) return untouched
  if (wholeInBackground) {
    const t = token()
    const main = picked.find(j => isLongRunner(j.text)) ?? (picked[picked.length - 1] as Job)
    const also = picked.filter(j => j !== main)
    return { command: supervised(script, t, ledger, 'task', shell, cmd), jobs: [{ text: main.text, index: main.index, token: t, mode: 'task', also }], unsafe: [] }
  }
  const segs = segments(cmd)
  const seg = segs[0]
  const plain = unquote(cmd)
  const live = withoutSingleQuotes(cmd)
  // Nothing before the one command, and after it nothing, or exactly one `&`: any other operator left over (an
  // empty segment the split dropped, as in `node app.js & &`) means the original is not what would be wrapped.
  const head = seg === undefined ? 'x' : cmd.slice(0, seg.start)
  const tail = seg === undefined ? 'x' : cmd.slice(seg.end)
  if (
    seg === undefined || segs.length !== 1 || !/^\s*$/.test(head) || !(seg.background ? /^\s*&\s*$/ : /^\s*$/).test(tail) ||
    lexicallyUnsafe(cmd) || /<</.test(plain) || UNSAFE.test(plain) || /\$\(|`/.test(live) || /^(exec|eval|source|\.)(\s|$)/.test(seg.text)
  ) return untouched
  const t = token()
  const job = picked[0] as Job
  if (seg.background) {
    // One command and a trailing `&`: the supervisor goes to the background in its place.
    return { command: `${supervised(script, t, ledger, 'detached', shell, seg.text)} &`, jobs: [{ text: job.text, index: 0, token: t, mode: 'detached', also: [] }], unsafe: [] }
  }
  return { command: supervised(script, t, ledger, 'task', shell, cmd.trim()), jobs: [{ text: job.text, index: 0, token: t, mode: 'task', also: [] }], unsafe: [] }
}

export type Ledger = { pid: number; lstart: string; mode: string; cwd: string }

// The supervisor's `TOKEN.run` file.
export function parseLedger(text: string): Ledger | null {
  const get = (k: string) => (text.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]
  const pid = Number(get('pid'))
  const lstart = (get('lstart') ?? '').trim().replace(/\s+/g, ' ')
  if (!Number.isInteger(pid) || pid <= 1 || lstart === '') return null
  return { pid, lstart, mode: get('mode') ?? '', cwd: get('cwd') ?? '' }
}

// The supervisor's `TOKEN.exit` file: how the job ended.
export function parseExit(text: string): { how: 'exited' | 'stopped' | 'killed'; code: number | null } {
  const exit = (text.match(/^exit=(.*)$/m) ?? [])[1] ?? ''
  if (exit === 'killed') return { how: 'killed', code: null }
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null)
  if (exit === 'stopped') return { how: 'stopped', code: num((text.match(/^code=(\d+)$/m) ?? [])[1]) }
  return { how: 'exited', code: num(exit) }
}

// The live supervisor this record names: same pid, same start time, and its command line carries our script
// and this job's token. Anything else (gone, or a reused pid) is not ours, and is never signalled.
export function supervisorRow(rows: PsRow[], pid: number, lstart: string, token: string): PsRow | null {
  const row = rows.find(r => r.pid === pid)
  if (row === undefined || row.lstart !== lstart) return null
  return row.command.includes('pc-run') && row.command.includes(` ${token} `) ? row : null
}

// The processes in a supervisor's group, the supervisor itself left out.
export function groupMembers(rows: PsRow[], leader: number): PsRow[] {
  return rows.filter(r => r.pgid === leader && r.pid !== leader)
}

// The job a supervisor runs, read back from its own command line (for one found in the ledger with no record).
export function commandOf(supervisorCommand: string): string {
  const at = supervisorCommand.indexOf(' -- ')
  return at < 0 ? '' : supervisorCommand.slice(at + 4)
}

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

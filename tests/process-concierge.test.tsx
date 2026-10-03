import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  detaches, display, identity, jobs, longRunner, matchWords, parseExit, parseLedger, parseLsof, parsePs, q,
  requestedPort, startDir, supervisorRow, wrap,
} from '../hooks/procs'

const SCRIPT = '/plugins/process-concierge/bin/pc-run'
const LEDGER = '/home/me/.cache/process-concierge/ledger'
const SH = '/bin/zsh'

describe('reading commands', () => {
  test('long runners, wrappers and detached commands', async () => {
    expect(longRunner('npm run dev')).toBe('npm run dev')
    expect(longRunner('cd web && PORT=4000 pnpm dev')).toBe('PORT=4000 pnpm dev')
    expect(longRunner('npx --yes vite')).toBe('npx --yes vite')
    expect(longRunner('npm run start-db')).toBe(null)
    expect(longRunner('docker compose up -d')).toBe(null)
    expect(longRunner('npm test')).toBe(null)
    expect(detaches('node server.js &')).toBe(true)
    expect(detaches('git commit -m "fix setsid leak & nohup"')).toBe(false)
    expect(jobs('node api.js & node worker.js &', false).map(j => j.text)).toEqual(['node api.js', 'node worker.js'])
  })

  test('ports, directories, identity and display', async () => {
    expect(requestedPort('npx vite --port 5174')).toBe(5174)
    expect(requestedPort('PORT=4000 pnpm dev')).toBe(4000)
    expect(requestedPort('ssh -p 2222 -N -L 9000:localhost:9000 host')).toBe(null)
    expect(startDir('cd a && cd b && npm run dev', 2, '/repo', '/home/me')).toBe('/repo/a/b')
    expect(startDir('cd a && npm run dev & cd b && npm run dev &', 3, '/repo', '/home/me')).toBe('/repo/b')
    expect(identity('yarn dev')).toBe(identity('npm run dev --host 0.0.0.0'))
    expect(display('API_KEY=abc123 npm run dev --token=xyz')).toBe('npm run dev --token=…')
    expect(display('psql postgres://me:hunter2@db/x')).not.toMatch(/hunter2/)
  })

  test('secret flag values never become identifying words', async () => {
    expect(matchWords('./worker --token abc')).toEqual(['worker'])
    expect(identity('./worker --token abc')).not.toMatch(/abc/)
  })
})

describe('wrapping jobs in the supervisor', () => {
  let n = 0
  const tok = () => `${'a'.repeat(23)}${(n += 1) % 10}`

  test('a run-in-background call is wrapped whole, in task mode', async () => {
    const w = wrap('cd web && npm run dev', true, SCRIPT, LEDGER, SH, tok)
    expect(w.jobs).toHaveLength(1)
    expect(w.jobs[0]?.mode).toBe('task')
    expect(w.command).toBe(`/usr/bin/env -u SHELLOPTS -u BASHOPTS /bin/sh ${q(SCRIPT)} ${w.jobs[0]?.token} ${q(LEDGER)} task ${q(SH)} -- ${q('cd web && npm run dev')}`)
  })

  test('a mixed "a & b" background call is one supervised group, so both siblings are covered', async () => {
    const w = wrap('node api.js & node worker.js', true, SCRIPT, LEDGER, SH, tok)
    expect(w.jobs).toHaveLength(1)
    expect(w.command).toContain(q('node api.js & node worker.js'))
  })

  test('a foreground call is wrapped only when it is one simple command, never split', async () => {
    const one = wrap('npm run dev > dev.log 2>&1 &', false, SCRIPT, LEDGER, SH, tok)
    expect(one.jobs.map(j => j.mode)).toEqual(['detached'])
    expect(one.command).toMatch(/^\/usr\/bin\/env -u SHELLOPTS -u BASHOPTS \/bin\/sh .* detached '\/bin\/zsh' -- 'npm run dev > dev\.log 2>&1' &$/)
    const fg = wrap('npx vite --port 5173', false, SCRIPT, LEDGER, SH, tok)
    expect(fg.jobs.map(j => j.mode)).toEqual(['task'])
    // An `&` mid-line: untouched (wrapping would change what the call returns); the jobs are reported for the
    // duplicate check only.
    for (const cmd of ["npm run dev & sleep 2 && curl -s 'localhost:4000'", 'node api.js & node worker.js &']) {
      const w = wrap(cmd, false, SCRIPT, LEDGER, SH, tok)
      expect(w.command).toBe(cmd)
      expect(w.jobs).toHaveLength(0)
      expect(w.unsafe.length).toBeGreaterThan(0)
    }
    // A whole list, foreground or ended by the line's one `&`: wrapped whole, the text unchanged inside.
    const list = wrap('cd web && npm run dev', false, SCRIPT, LEDGER, SH, tok)
    expect(list.jobs.map(j => [j.mode, j.text])).toEqual([['task', 'npm run dev']])
    expect(list.command).toContain(`-- ${q('cd web && npm run dev')}`)
    const bgList = wrap('cd web && npm run dev &', false, SCRIPT, LEDGER, SH, tok)
    expect(bgList.jobs.map(j => j.mode)).toEqual(['detached'])
    expect(bgList.command).toMatch(new RegExp(`-- ${q('cd web && npm run dev').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} &$`))
  })

  test('constructs that splitting could change are never rewritten', async () => {
    for (const cmd of [
      'exec npm run dev', 'exec npm run dev; dangerous-command',
      'set -C; npm run dev > existing.log &', 'npm run dev --tag "$(whoami)" &', 'eval npm run dev', 'setsid node server.js &',
      'setsid --invalid-option npm run dev &', 'nohup setsid npm run dev &', '/usr/bin/setsid npm run dev &',
      'node app.js & &', 'node app.js & ||', 'node app.js & &&', 'node app.js & ;', 'node app.js &|', 'npm run dev &&', 'npm run dev ||',
      '; npm run dev &',
    ]) {
      const w = wrap(cmd, false, SCRIPT, LEDGER, SH, tok)
      expect(w.command).toBe(cmd)
      expect(w.jobs).toHaveLength(0)
    }
  })

  test('a `>|` redirect is not a pipe, and the text reaches the shell unchanged', async () => {
    const w = wrap('npm run dev 2>| log &', false, SCRIPT, LEDGER, SH, tok)
    expect(w.jobs.map(j => j.text)).toEqual(['npm run dev 2>| log'])
    expect(w.command).toContain(`-- ${q('npm run dev 2>| log')} &`)
  })

  test('disguised setsid, ANSI-C and glued quotes, and computed command words are never wrapped or checked', async () => {
    for (const [cmd, background] of [
      ["$'setsid' npm run dev &", false], ["set''sid npm run dev &", false], ['"set"sid npm run dev &', false],
      ["cd web && $'setsid' npm run dev", true], ['X=setsid; $X npm run dev', true], ['"$RUNNER" run dev &', false],
      ['cat <<EOF &\nnpm run dev\nEOF', false], ['echo \\& npm run dev &', false], ['npm run dev # & npm run dev', false],
      ['node app.js & &', false], ['cd - && npm run dev &', false],
    ] as [string, boolean][]) {
      const w = wrap(cmd, background, SCRIPT, LEDGER, SH, tok)
      expect(w.command).toBe(cmd)
      expect(w.jobs).toHaveLength(0)
      // Unreadable or malformed: not even the duplicate check may refuse it.
      expect(w.unsafe).toHaveLength(0)
    }
    // `=` before a quote is an ordinary argument, not a glued word.
    expect(wrap('npx vite --port="5173" &', false, SCRIPT, LEDGER, SH, tok).jobs).toHaveLength(1)
  })

  test('start directories: env -C, pushd/popd, and arguments after --', async () => {
    expect(startDir('/usr/bin/env -C /tmp npm run dev', 0, '/repo', '/home/me')).toBe('/tmp')
    expect(startDir('env --chdir=/srv npm run dev', 0, '/repo', '/home/me')).toBe('/srv')
    expect(startDir('pushd /tmp && popd && npm run dev', 2, '/repo', '/home/me')).toBe('/repo')
    expect(startDir('cd && npm run dev', 1, '/repo', '/home/me')).toBe('/home/me')
    expect(startDir('npm run dev -- --cwd /tmp', 0, '/repo', '/home/me')).toBe('/repo')
    expect(startDir('npm --prefix web run dev', 0, '/repo', '/home/me')).toBe('/repo/web')
  })

  test('commands in a pipeline run at the same time', async () => {
    expect(jobs('npm run dev | tee dev.log', false).map(j => j.concurrent)).toEqual([true])
    expect(jobs('npm run dev || npm run dev', false).every(j => !j.concurrent)).toBe(true)
  })

  test('quotes in a job survive the wrapping', async () => {
    expect(q("it's")).toBe(`'it'\\''s'`)
    const w = wrap(`node app.js --name 'a b' &`, false, SCRIPT, LEDGER, SH, tok)
    expect(w.command).toContain(`-- 'node app.js --name '\\''a b'\\'''`)
  })

  test('jobs in syntax the mod does not read are left untouched, and not even checked', async () => {
    const sub = wrap('(npm run dev &)', false, SCRIPT, LEDGER, SH, tok)
    expect(sub.command).toBe('(npm run dev &)')
    expect(sub.unsafe).toHaveLength(0)
    const doc = wrap('cat <<EOF > x\nhi\nEOF\nnode s.js &', false, SCRIPT, LEDGER, SH, tok)
    expect(doc.command).toBe('cat <<EOF > x\nhi\nEOF\nnode s.js &')
    expect(doc.jobs).toHaveLength(0)
  })

  test('a comment or an escape is never turned into a command', async () => {
    // In the shell, `rm` here is inside a comment / an argument to echo; a naive split would run it.
    for (const cmd of ['npm run dev # note: & rm -rf /tmp/important', 'echo \\& rm -rf /tmp/important &', "printf foo\\&bar &"]) {
      const w = wrap(cmd, false, SCRIPT, LEDGER, SH, tok)
      expect(w.command).toBe(cmd)
      expect(w.jobs).toHaveLength(0)
    }
    // A `#` inside a word or inside quotes is not a comment.
    expect(wrap("node s.js --tag 'a#b' &", false, SCRIPT, LEDGER, SH, tok).jobs).toHaveLength(1)
    expect(wrap('node s.js --tag a#b &', false, SCRIPT, LEDGER, SH, tok).jobs).toHaveLength(1)
    // A run-in-background line keeps any setsid: it is left untouched, by path or inside double quotes too.
    expect(wrap('cd web && setsid npm run dev', true, SCRIPT, LEDGER, SH, tok).jobs).toHaveLength(0)
    expect(wrap('bash -c "setsid npm run dev"', true, SCRIPT, LEDGER, SH, tok).jobs).toHaveLength(0)
    expect(wrap("echo 'setsid is a word' && npm run dev", true, SCRIPT, LEDGER, SH, tok).jobs).toHaveLength(1)
  })

  test('a run-in-background line with several servers covers each one for the duplicate check', async () => {
    const w = wrap('npm run dev & python3 -m http.server 8000', true, SCRIPT, LEDGER, SH, tok)
    expect(w.jobs[0]?.text).toBe('npm run dev')
    expect(w.jobs[0]?.also.map(j => j.text)).toEqual(['python3 -m http.server 8000'])
  })
})

describe('reading the supervisor', () => {
  test('ledger and exit files', async () => {
    expect(parseLedger('pid=700\nlstart=Thu Oct  2 10:00:00 2026\nmode=detached\ncwd=/repo\n')).toEqual({
      pid: 700, lstart: 'Thu Oct 2 10:00:00 2026', mode: 'detached', cwd: '/repo',
    })
    expect(parseLedger('pid=1\nlstart=x\n')).toBe(null)
    expect(parseExit('exit=0\n')).toEqual({ how: 'exited', code: 0 })
    expect(parseExit('exit=stopped\ncode=143\n')).toEqual({ how: 'stopped', code: 143 })
    expect(parseExit('exit=killed\n')).toEqual({ how: 'killed', code: null })
    // No exit record: the code is unknown, not 0.
    expect(parseExit('')).toEqual({ how: 'exited', code: null })
  })

  test('a supervisor is ours only with the same pid, start time, script and token', async () => {
    const rows = parsePs(
      ' 700 1 700 0.0 1024 Thu Oct  2 10:00:00 2026 /bin/sh /p/bin/pc-run aaaaaaaaaaaaaaaaaaaaaaaa /l detached -- npm run dev\n' +
        ' 800 1 800 0.0 1024 Thu Oct  2 10:00:00 2026 node server.js aaaaaaaaaaaaaaaaaaaaaaaa\n',
    )
    expect(supervisorRow(rows, 700, 'Thu Oct 2 10:00:00 2026', 'aaaaaaaaaaaaaaaaaaaaaaaa')?.pid).toBe(700)
    // Same pid, a different start time: the pid was reused.
    expect(supervisorRow(rows, 700, 'Thu Oct 2 09:00:00 2026', 'aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(null)
    // Another token, or a process that merely carries the token in its arguments.
    expect(supervisorRow(rows, 700, 'Thu Oct 2 10:00:00 2026', 'bbbbbbbbbbbbbbbbbbbbbbbb')).toBe(null)
    expect(supervisorRow(rows, 800, 'Thu Oct 2 10:00:00 2026', 'aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(null)
    expect(parseLsof('p102\nn*:5173\nn127.0.0.1:24678\n').get(102)).toEqual([5173, 24678])
  })
})

// A small fake OS: processes with groups, a file system for the ledger, and a supervisor that does what
// bin/pc-run does when its stop file appears.
type FakeProc = { pid: number; ppid: number; pgid: number; command: string; lstart: string; ports: number[]; stubborn?: boolean }

const LSTART = 'Thu Oct 2 10:00:00 2026'

function fakeOs() {
  const table: FakeProc[] = [{ pid: 1, ppid: 0, pgid: 1, command: '/sbin/launchd', lstart: 'Mon Sep 1 00:00:00 2026', ports: [] }]
  const files = new Map<string, string>()
  const argvs: string[][] = []
  let next = 700
  const out = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const answer = (argv: readonly string[]) => {
    argvs.push([...argv])
    // Helpers are run by absolute path; the fake answers by program name.
    const prog = (argv[0] ?? '').split('/').pop()
    if (prog === 'ps' && argv.includes('-p')) {
      const pid = Number(argv[argv.indexOf('-p') + 1])
      const p = table.find(x => x.pid === pid)
      return p === undefined ? out('', 1) : out(`${p.lstart}\n`)
    }
    if (prog === 'ps') return out(table.map(p => `${p.pid} ${p.ppid} ${p.pgid} 1.0 2048 ${p.lstart}  ${p.command}`).join('\n'))
    if (prog === 'lsof') {
      const lines = table.filter(p => p.ports.length > 0).flatMap(p => [`p${p.pid}`, ...p.ports.map(n => `n*:${n}`)])
      return out(lines.join('\n'), lines.length > 0 ? 0 : 1)
    }
    if (prog === 'rm') {
      for (const path of argv.slice(3)) files.delete(path)
      return out('')
    }
    return out('', 1)
  }
  // What the shell does with a command the mod rewrote: each supervisor starts, checks in, runs its job.
  const launch = (command: string, job: { command: string; ports: number[] }) => {
    const re = /\/bin\/sh '[^']*pc-run' ([0-9a-f]+) '([^']*)' (task|detached) '[^']*' -- /g
    const found: string[] = []
    for (let m = re.exec(command); m !== null; m = re.exec(command)) {
      const [, token, ledger, mode] = m as unknown as [string, string, string, string]
      const pid = (next += 10)
      table.push({ pid, ppid: 1, pgid: pid, command: `/bin/sh /plugins/process-concierge/bin/pc-run ${token} ${ledger} ${mode} -- ${job.command}`, lstart: LSTART, ports: [] })
      table.push({ pid: pid + 1, ppid: pid, pgid: pid, command: job.command, lstart: LSTART, ports: job.ports })
      files.set(`${ledger}/${token}.run`, `pid=${pid}\nlstart=${LSTART}\nmode=${mode}\ncwd=/repo\n`)
      found.push(token)
    }
    return found
  }
  // The supervisor's side of a stop: it signals its own group and records how it ended.
  const write = (path: string, text: string) => {
    files.set(path, text)
    const m = path.match(/\/([0-9a-f]+)\.stop$/)
    if (m === null) return
    const sup = table.find(p => p.command.includes(` ${m[1]} `) && p.command.includes('pc-run'))
    if (sup === undefined) return
    const group = table.filter(p => p.pgid === sup.pid)
    if (group.some(p => p.stubborn === true)) return
    for (const p of group) table.splice(table.indexOf(p), 1)
    files.set(path.replace(/\.stop$/, '.exit'), 'exit=stopped\ncode=143\n')
  }
  const os = { table, files, argvs, answer, launch, write }
  return os
}

const stores = new WeakMap<object, Map<string, unknown>>()

function world(on: On, os: ReturnType<typeof fakeOs>, failWrites = false, tools = true) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-02T10:00:00Z') })
  // A store the test can read back: what the mod persists.
  const store = new Map<string, unknown>()
  stores.set(os, store)
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, { HOME: '/home/me', SHELL: '/bin/zsh' })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('process.run', (_$, e) => ({ value: os.answer(e.argv) }))  // os.answer may be swapped by a test
  on('fs.stat', (_$, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } as never }))
  on('fs.read', (_$, e) => (os.files.has(e.path) ? { value: os.files.get(e.path) as string } : { deny: 'ENOENT' }))
  on('fs.write', (_$, e) => {
    if (failWrites) return { deny: 'EACCES' }
    os.write(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: (tools && ['/usr/bin/perl', '/usr/bin/env', '/bin/ps', '/usr/sbin/lsof', '/bin/rm'].includes(e.path)) || os.files.has(e.path) }))
  on('fs.list', (_$, e) => ({
    value: [...os.files.keys()]
      .filter(k => k.startsWith(`${e.path}/`))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) as never,
  }))
  return clock
}

const bg = (command: string) => ({ tool: 'Bash' as const, command, run_in_background: true })
const started = { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task' } }
const contextOf = (ran: unknown) => ((ran as { context?: readonly string[] }).context ?? []).join('\n')
const procsText = async ($: { command: { run: (a: never) => Promise<{ text?: string }> } }) =>
  String((await $.command.run({ command: 'procs', args: '' } as never)).text ?? '')
const signalled = (os: ReturnType<typeof fakeOs>) => os.argvs.filter(a => a[0] === 'kill' || a.join(' ').includes('kill '))

test('a background dev server runs under the supervisor and is tracked with its port', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  let seen = ''
  on('tool.call', (_$, e) => {
    seen = String((e as { command: string }).command)
    os.launch(seen, { command: 'npm run dev', ports: [5173] })
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  const ran = await $.tool.call(bg('npm run dev'))
  expect(seen).toMatch(/pc-run' [0-9a-f]+ '\/home\/me\/\.cache\/process-concierge\/ledger' task '\/bin\/zsh' -- 'npm run dev'$/)
  expect(contextOf(ran)).toMatch(/supervisor/)
  expect(await procsText($ as never)).toMatch(/npm run dev on :5173/)
})

test('the permission check answers for the command the model asked for, not the wrapper', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  const checked: string[] = []
  on('tool.check', (_$, e) => {
    const cmd = String((e.input as { command: string }).command)
    checked.push(cmd)
    return { decision: cmd === 'npm run dev' ? ('allow' as const) : ('ask' as const) }
  })
  let seen = ''
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('tool.call', async (_$, e) => {
    seen = String((e as { command: string }).command)
    await gate
    os.launch(seen, { command: 'npm run dev', ports: [] })
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  const call = $.tool.call(bg('npm run dev'))
  const timer = (globalThis as unknown as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
  for (let i = 0; i < 400 && seen === ''; i += 1) {
    await new Promise<void>(resolve => (timer === undefined ? resolve() : void timer(resolve, 5)))
  }
  expect(seen).toContain('pc-run')
  // While the wrapped call is in flight, the check for the wrapper is the check for the original command.
  expect((await $.tool.check({ tool: 'Bash', input: { command: seen, run_in_background: true } })).decision).toBe('allow')
  expect(checked).toEqual(['npm run dev'])
  // An unrelated command naming the wrapper is not translated.
  expect((await $.tool.check({ tool: 'Bash', input: { command: `${seen} ; rm -rf x` } })).decision).toBe('ask')
  // Nor is the rewritten command with any other argument changed.
  expect((await $.tool.check({ tool: 'Bash', input: { command: seen, run_in_background: true, dangerouslyDisableSandbox: true } })).decision).toBe('ask')
  release()
  await call
  // After the call, the wrapper text is no longer translated either.
  expect((await $.tool.check({ tool: 'Bash', input: { command: seen, run_in_background: true } })).decision).toBe('ask')
})

test('stop asks the supervisor through its stop file; the mod itself never signals a process', async ($, on) => {
  const os = fakeOs()
  const clock = world(on, os)
  on('tool.call', (_$, e) => {
    os.launch(String((e as { command: string }).command), { command: 'node server.js --port 4000', ports: [4000] })
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('node server.js --port 4000'))
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  expect([...os.files.keys()].some(k => k.endsWith('.stop'))).toBe(true)
  await clock.advance(5_000)
  expect(await procsText($ as never)).toMatch(/no tracked jobs are running/)
  expect(signalled(os)).toEqual([])
})

test('a refresh during the grace period leaves the stop workflow in charge', async ($, on) => {
  const os = fakeOs()
  const clock = world(on, os)
  on('tool.call', (_$, e) => {
    os.launch(String((e as { command: string }).command), { command: 'node server.js', ports: [] })
    // This job ignores SIGTERM until the supervisor's SIGKILL, which the fake leaves to the final look.
    for (const p of os.table) if (p.command === 'node server.js') p.stubborn = true
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('node server.js'))
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  await clock.advance(1_500)
  // A refresh in the grace period (the /procs command refreshes) must not end the stop.
  expect(await procsText($ as never)).toMatch(/\[stopping\]/)
  // Still alive at the final look: back to running, with the reason, never reported as stopped.
  await clock.advance(11_000)
  const end = await procsText($ as never)
  expect(end).toMatch(/\[running\].*still running/)
  expect(end).not.toMatch(/\[stopped\]/)
})

test('a stop file that cannot be written is reported, and nothing claims the job stopped', async ($, on) => {
  const os = fakeOs()
  world(on, os, true)
  on('tool.call', (_$, e) => {
    os.launch(String((e as { command: string }).command), { command: 'node server.js', ports: [] })
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('node server.js'))
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  const text = await procsText($ as never)
  expect(text).toMatch(/\[running\].*could not ask it to stop/)
})

test('a supervisor whose pid is reused by another process is never taken for the job', async ($, on) => {
  const os = fakeOs()
  const clock = world(on, os)
  on('tool.call', (_$, e) => {
    os.launch(String((e as { command: string }).command), { command: 'node server.js', ports: [] })
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('node server.js'))
  const sup = os.table.find(p => p.command.includes('pc-run')) as FakeProc
  // The supervisor exits; an unrelated process gets its pid.
  os.table.splice(0, os.table.length, os.table[0] as FakeProc, { ...sup, lstart: 'Thu Oct 2 11:00:00 2026', command: 'vim notes.txt', pgid: sup.pid })
  await clock.advance(16_000)
  expect(await procsText($ as never)).toMatch(/no tracked jobs are running/)
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  expect([...os.files.keys()].some(k => k.endsWith('.stop'))).toBe(false)
})

test("someone else's server on the machine is shown only, never stoppable", async ($, on) => {
  const os = fakeOs()
  world(on, os)
  os.table.push({ pid: 520, ppid: 1, pgid: 520, command: 'npm run dev --token secret123', lstart: LSTART, ports: [3001] })
  const text = await procsText($ as never)
  expect(text).toMatch(/\[not ours, shown only\] pid 520 on :3001/)
  expect(text).not.toMatch(/secret123/)
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  await $.command.run({ command: 'procs', args: 'clean' } as never)
  expect([...os.files.keys()].some(k => k.endsWith('.stop'))).toBe(false)
})

test('a job in syntax the mod cannot read is run as written, neither recorded nor refused', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  let seen = ''
  on('tool.call', (_$, e) => {
    seen = String((e as { command: string }).command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call({ tool: 'Bash', command: '(cd web && npm run dev &)' })
  expect(seen).toBe('(cd web && npm run dev &)')
  expect(await procsText($ as never)).not.toMatch(/npm run dev/)
})

test('a supervisor from an earlier session found in the ledger is listed and can be stopped', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  const token = 'cccccccccccccccccccccccc'
  os.table.push({ pid: 900, ppid: 1, pgid: 900, command: `/bin/sh /plugins/process-concierge/bin/pc-run ${token} ${LEDGER} detached -- python3 -m http.server 9000`, lstart: LSTART, ports: [] })
  os.table.push({ pid: 901, ppid: 900, pgid: 900, command: 'python3 -m http.server 9000', lstart: LSTART, ports: [9000] })
  os.files.set(`${LEDGER}/${token}.run`, `pid=900\nlstart=${LSTART}\nmode=detached\ncwd=/repo\n`)
  const text = await procsText($ as never)
  expect(text).toMatch(/http\.server 9000 on :9000/)
  expect(text).toMatch(/earlier session/)
  await $.command.run({ command: 'procs', args: 'clean' } as never)
  expect(os.files.has(`${LEDGER}/${token}.stop`)).toBe(true)
})

test('starting a server on a port a tracked job already serves is refused', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  let starts = 0
  on('tool.call', (_$, e) => {
    starts += 1
    os.launch(String((e as { command: string }).command), { command: 'python3 -m http.server 8000', ports: [8000] })
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('python3 -m http.server 8000'))
  const again = await $.tool.call(bg('python3 -m http.server 8000'))
  expect(again.deny).toMatch(/port 8000/)
  expect(starts).toBe(1)
})

test('a foreground line starting the same server twice at once is refused; a fallback with || is not', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  let starts = 0
  on('tool.call', () => {
    starts += 1
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  const twice = await $.tool.call({ tool: 'Bash', command: 'npm run dev & npm run dev' })
  expect(twice.deny).toMatch(/same job twice/)
  expect(starts).toBe(0)
  const bgFallback = await $.tool.call(bg('npm run dev || npm run dev'))
  expect(bgFallback.deny).toBe(undefined)
})

test('servers of one background line in different folders are not taken for duplicates', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  on('tool.call', (_$, e) => {
    os.launch(String((e as { command: string }).command), { command: 'npm run dev', ports: [] })
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  const ran = await $.tool.call(bg('cd api && npm run dev & cd web && npm run dev'))
  expect(ran.deny).toBe(undefined)
})

test('stored records keep no argument values', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  on('tool.call', (_$, e) => {
    os.launch(String((e as { command: string }).command), { command: './worker --token abc', ports: [] })
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('./worker --token abc'))
  const store = stores.get(os) as Map<string, unknown>
  expect(store.size).toBeGreaterThan(0)
  for (const v of store.values()) expect(JSON.stringify(v)).not.toMatch(/\babc\b/)
})

test('a fallback with || is not refused as starting the same job twice', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  let starts = 0
  on('tool.call', () => {
    starts += 1
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run dev || npm run dev' })
  expect(ran.deny).toBe(undefined)
  expect(starts).toBe(1)
})

test('a supervisor that checks in just after the table was read is not taken for finished', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  let reads = 0
  on('tool.call', (_$, e) => {
    os.launch(String((e as { command: string }).command), { command: 'node server.js', ports: [] })
    // Hide the supervisor from the next process-table read only, as if it started between the two looks.
    const hidden = os.table.filter(p => p.pid > 1)
    const answer = os.answer
    os.answer = (argv: readonly string[]) => {
      if ((argv[0] ?? '').endsWith('/ps') && reads === 0) {
        reads += 1
        const keep = os.table.splice(0, os.table.length, ...os.table.filter(p => !hidden.includes(p)))
        const r = answer(argv)
        os.table.splice(0, os.table.length, ...keep)
        return r
      }
      return answer(argv)
    }
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('node server.js'))
  expect(await procsText($ as never)).toMatch(/\[running\]/)
})

test('a job recovered from the ledger keeps its duplicate key: the same server is not started twice after a crash', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  const token = 'dddddddddddddddddddddddd'
  os.table.push({ pid: 950, ppid: 1, pgid: 950, command: `/bin/sh /plugins/process-concierge/bin/pc-run ${token} ${LEDGER} task /bin/zsh -- cd web && npm run dev`, lstart: LSTART, ports: [] })
  os.table.push({ pid: 951, ppid: 950, pgid: 950, command: 'npm run dev', lstart: LSTART, ports: [] })
  os.files.set(`${LEDGER}/${token}.run`, `pid=950\nlstart=${LSTART}\nmode=task\ncwd=/repo\n`)
  let starts = 0
  on('tool.call', () => {
    starts += 1
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  const again = await $.tool.call(bg('cd web && npm run dev'))
  expect(again.deny).toMatch(/already running/)
  expect(starts).toBe(0)
})

test('a stop whose settling timers were lost to a reload still finishes once the supervisor is gone', async ($, on) => {
  const os = fakeOs()
  const clock = world(on, os)
  // A record persisted mid-stop by an earlier load of the module, whose supervisor has since exited.
  const store = stores.get(os) as Map<string, unknown>
  store.set('proc:old-1', {
    id: 'old-1', token: 'eeeeeeeeeeeeeeeeeeeeeeee', sessionId: 'session-0', command: 'node server.js', keys: ['k'], wants: [4000],
    cwd: '/repo', startedAt: Date.parse('2026-10-02T09:00:00Z'), mode: 'detached', supervisor: { pid: 960, lstart: LSTART },
    members: [], ports: [4000], status: 'stopping', cpu: 0, memMb: 0, exitCode: null, stopAt: Date.parse('2026-10-02T09:59:00Z'),
    checkedAt: 0, note: '',
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await clock.advance(5_000)
  const text = await procsText($ as never)
  expect(text).toMatch(/\[stopped\]/)
  expect(text).not.toMatch(/\[stopping\]/)
})

test('a backgrounded fallback list (a || b &) is one list, not two servers at once', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.command.run({ command: 'procs', args: '' } as never)
  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run dev || npm run dev &' })
  expect(ran.deny).toBe(undefined)
})

test('a short job that finished between looks is reported as finished, not unsupervised', async ($, on) => {
  const os = fakeOs()
  const clock = world(on, os)
  on('tool.call', (_$, e) => {
    const [token] = os.launch(String((e as { command: string }).command), { command: 'npm run dev', ports: [] })
    // The supervisor ran, finished and removed its .run before Process Concierge looked.
    os.table.splice(1)
    os.files.delete(`${LEDGER}/${token}.run`)
    os.files.set(`${LEDGER}/${token}.exit`, 'exit=0\n')
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('npm run dev'))
  await clock.advance(31_000)
  const text = await procsText($ as never)
  expect(text).toMatch(/\[exited\]/)
  expect(text).not.toMatch(/unsupervised/)
})

test('without perl nothing is rewritten, and nothing is recorded or refused', async ($, on) => {
  const os = fakeOs()
  world(on, os, false, false)
  let seen = ''
  on('tool.call', (_$, e) => {
    seen = String((e as { command: string }).command)
    return started
  })
  await $.command.run({ command: 'procs', args: '' } as never)
  await $.tool.call(bg('npm run dev'))
  expect(seen).toBe('npm run dev')
  expect(await procsText($ as never)).not.toMatch(/npm run dev/)
})

test('a ledger whose supervisor checked in after the boot-time table was read is kept; a dead one is removed', async ($, on) => {
  const os = fakeOs()
  world(on, os)
  const live = 'dddddddddddddddddddddddd'
  const dead = 'eeeeeeeeeeeeeeeeeeeeeeee'
  const sup = { pid: 950, ppid: 1, pgid: 950, command: `/bin/sh /plugins/process-concierge/bin/pc-run ${live} ${LEDGER} detached -- node s.js`, lstart: LSTART, ports: [] }
  os.files.set(`${LEDGER}/${live}.run`, `pid=950\nlstart=${LSTART}\nmode=detached\ncwd=/repo\n`)
  os.files.set(`${LEDGER}/${dead}.run`, `pid=960\nlstart=${LSTART}\nmode=detached\ncwd=/repo\n`)
  // The whole-table read at boot misses the live supervisor; it is there by the time one pid is looked at again.
  const answer = os.answer
  os.answer = (argv: readonly string[]) => {
    if ((argv[0] ?? '').endsWith('/ps') && argv.includes('-p') && !os.table.includes(sup)) os.table.push(sup)
    return answer(argv)
  }
  await $.command.run({ command: 'procs', args: '' } as never)
  expect(os.files.has(`${LEDGER}/${live}.run`)).toBe(true)
  expect(os.files.has(`${LEDGER}/${dead}.run`)).toBe(false)
})

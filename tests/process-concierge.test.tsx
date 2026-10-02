import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import {
  commandMatches, detaches, display, identity, jobs, longRunner, matchWords, newRoots, parseEnv, parseLsof, parsePs,
  requestedPort, startDir,
} from '../hooks/procs'

describe('reading commands', () => {
  test('long runners, wrappers and detached commands', async () => {
    expect(longRunner('npm run dev')).toBe('npm run dev')
    expect(longRunner('cd web && PORT=4000 pnpm dev')).toBe('PORT=4000 pnpm dev')
    expect(longRunner('npx expo start --clear')).toBe('npx expo start --clear')
    expect(longRunner('npx --yes vite')).toBe('npx --yes vite')
    expect(longRunner('npm --prefix web run dev')).toBe('npm --prefix web run dev')
    expect(longRunner('sudo -u bob npm run dev')).toBe('sudo -u bob npm run dev')
    expect(longRunner('pnpm exec next dev')).toBe('pnpm exec next dev')
    expect(longRunner('npm run dev:web')).toBe('npm run dev:web')
    expect(longRunner('npm run start-db')).toBe(null)
    expect(longRunner('npm run storybook-build')).toBe(null)
    expect(longRunner('docker compose up -d')).toBe(null)
    expect(longRunner('npm test')).toBe(null)
    expect(detaches('node server.js &')).toBe(true)
    expect(detaches('nohup ./worker.sh > log 2>&1 &')).toBe(true)
    expect(detaches('git commit -m "fix setsid leak & nohup"')).toBe(false)
    expect(jobs('node api.js & node worker.js &', false).map(j => j.text)).toEqual(['node api.js', 'node worker.js'])
    expect(jobs('cd a && npm run dev & cd b && npm run dev &', false).map(j => j.index)).toEqual([1, 3])
  })

  test('match words identify the job: program, script or path, and a command-line port', async () => {
    expect(matchWords('npm run dev')).toEqual(['npm', 'dev'])
    expect(matchWords('npx --yes vite --port 5174')).toEqual(['vite', '5174'])
    expect(matchWords('python3 -m http.server 8000')).toEqual(['python3', 'http.server', '8000'])
    expect(matchWords('go run ./cmd/api')).toEqual(['go', 'run', 'api'])
    expect(matchWords('node --watch server.js')).toEqual(['node', 'server'])
    expect(commandMatches('python3 -m http.server 8001', ['python3', 'http.server', '8000'])).toBe(false)
    expect(commandMatches('go run ./cmd/worker', ['go', 'run', 'api'])).toBe(false)
    expect(commandMatches('npm run devtools', ['npm', 'dev'])).toBe(false)
    expect(commandMatches('node /x/node_modules/vite/bin/vite.js --port 5174', ['vite', '5174'])).toBe(true)
  })

  test('ports, directories, identity and display', async () => {
    expect(requestedPort('npx vite --port 5174')).toBe(5174)
    expect(requestedPort('PORT=4000 pnpm dev')).toBe(4000)
    expect(requestedPort('docker run -p 127.0.0.1:8080:80 nginx')).toBe(8080)
    expect(requestedPort('gunicorn -b 0.0.0.0:8000 app:app')).toBe(8000)
    expect(requestedPort('ssh -p 2222 -N -L 9000:localhost:9000 host')).toBe(null)
    expect(startDir('cd a && cd b && npm run dev', 2, '/repo', '/home/me')).toBe('/repo/a/b')
    expect(startDir('cd ~/proj && npm run dev', 1, '/repo', '/home/me')).toBe('/home/me/proj')
    expect(startDir('cd a && npm run dev & cd b && npm run dev &', 3, '/repo', '/home/me')).toBe('/repo/b')
    expect(startDir('npm --prefix web run dev', 0, '/repo', '/home/me')).toBe('/repo/web')
    expect(identity('yarn dev')).toBe(identity('npm run dev --host 0.0.0.0'))
    expect(identity('npm run dev:web')).not.toBe(identity('npm run dev'))
    expect(display('API_KEY=abc123 npm run dev --token=xyz')).toBe('npm run dev --token=…')
    expect(display('node app.js --password "alpha beta"')).not.toMatch(/alpha|beta/)
    expect(display('psql postgres://me:hunter2@db/x')).not.toMatch(/hunter2/)
  })

  test('ps, lsof and environment output', async () => {
    const rows = parsePs(' 101     1   0.5  20480 Thu Oct  2 10:00:00 2026     npm run dev\n')
    expect(rows[0]?.lstart).toBe('Thu Oct 2 10:00:00 2026')
    expect(parseLsof('p102\nn*:5173\nn127.0.0.1:24678\n').get(102)).toEqual([5173, 24678])
    expect(newRoots(new Set([1]), rows, ['npm', 'dev']).map(r => r.pid)).toEqual([101])
    const env = parseEnv('101 node a.js PATH=/bin HOME=/h CLAUDE_PID=42 CLAUDE_CODE_SESSION_ID=s-1\n102 tail -f x\n')
    expect(env.get(101)).toEqual({ visible: true, claudePid: 42, sessionId: 's-1' })
    expect(env.get(102)?.visible).toBe(false)
  })
})

// A tiny fake OS behind $.process.run. `env` is what `ps -E` shows: started through this Claude Code
// (the default), by the user in their own terminal, or hidden by the OS.
type FakeProc = {
  pid: number; ppid: number; command: string; lstart: string; ports: number[]; cwd: string; stubborn?: boolean
  env?: 'ours' | 'user' | 'hidden'
}

const HOST = 4242

function fakeOs() {
  const table: FakeProc[] = [{ pid: 1, ppid: 0, command: '/sbin/launchd', lstart: 'Mon Sep 1 00:00:00 2026', ports: [], cwd: '/', env: 'hidden' }]
  const kills: { signal: string; pids: number[] }[] = []
  const locales: (string | undefined)[] = []
  const out = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  const envText = (p: FakeProc) =>
    p.env === 'hidden' ? '' : p.env === 'user' ? ' PATH=/bin HOME=/home/me TERM=xterm' : ` PATH=/bin HOME=/home/me CLAUDE_PID=${HOST} CLAUDE_CODE_SESSION_ID=session-1`
  const answer = (argv: readonly string[], init?: { env?: Record<string, string> }) => {
    if (argv[0] === 'ps') locales.push(init?.env?.LC_ALL)
    if (argv[0] === 'ps' && argv.includes('-E')) {
      const want = String(argv[argv.length - 1]).split(',').map(Number)
      return out(table.filter(p => want.includes(p.pid)).map(p => `${p.pid} ${p.command}${envText(p)}`).join('\n'))
    }
    if (argv[0] === 'ps') return out(table.map(p => `${p.pid} ${p.ppid} 1.0 2048 ${p.lstart}  ${p.command}`).join('\n'))
    if (argv[0] === 'lsof' && argv.includes('cwd')) {
      const want = String(argv[argv.length - 1]).split(',').map(Number)
      return out(table.filter(p => want.includes(p.pid)).map(p => `p${p.pid}\nfcwd\nn${p.cwd}`).join('\n'))
    }
    if (argv[0] === 'lsof') {
      const lines = table.filter(p => p.ports.length > 0).flatMap(p => [`p${p.pid}`, ...p.ports.map(n => `n*:${n}`)])
      return out(lines.join('\n'), lines.length > 0 ? 0 : 1)
    }
    if (argv[0] === 'sh' && String(argv[2]).includes('echo $PPID')) return out(`${HOST} ${HOST}\n`)
    if (argv[0] === 'sh' && String(argv[2]).includes('kill')) {
      // The signal script: signal a pid only while it still has the recorded start time.
      const signal = `-${String(argv[4])}`
      const pids: number[] = []
      for (const spec of argv.slice(5)) {
        const i = String(spec).indexOf(':')
        const pid = Number(String(spec).slice(0, i))
        const lstart = String(spec).slice(i + 1)
        const at = table.findIndex(p => p.pid === pid && p.lstart === lstart)
        if (at < 0) continue
        pids.push(pid)
        if (signal === '-KILL' || table[at]?.stubborn !== true) table.splice(at, 1)
      }
      kills.push({ signal, pids })
      return out(pids.map(String).join('\n'))
    }
    return out('', 1)
  }
  return { table, kills, locales, answer }
}

function world(on: On) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-02T10:00:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  return clock
}

// `ps` prints start times in local time: build one for a moment the mock clock knows.
function lst(ms: number): string {
  const d = new Date(ms)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const two = (n: number) => String(n).padStart(2, '0')
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`
}

const bg = (command: string) => ({ tool: 'Bash' as const, command, run_in_background: true })
const started = { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task' } }
const killed = (os: ReturnType<typeof fakeOs>, signal: string) => os.kills.filter(k => k.signal === signal).flatMap(k => k.pids)
const contextOf = (ran: unknown) => ((ran as { context?: readonly string[] }).context ?? []).join('\n')
const procsText = async ($: { command: { run: (a: never) => Promise<{ text?: string }> } }) =>
  String((await $.command.run({ command: 'procs', args: '' } as never)).text ?? '')

test('a background dev server is tracked with its pid and port, and the model is told', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 500, ppid: 1, command: 'npm run dev', lstart: 'Thu Oct 2 10:00:00 2026', ports: [], cwd: '/repo' })
    os.table.push({ pid: 501, ppid: 500, command: 'node /repo/node_modules/vite/bin/vite.js', lstart: 'Thu Oct 2 10:00:01 2026', ports: [5173], cwd: '/repo' })
    return started
  })
  const ran = await $.tool.call(bg('npm run dev'))
  expect(contextOf(ran)).toMatch(/pid 500,501/)
  expect(contextOf(ran)).toMatch(/:5173/)
  // Every ps call reads the C locale, so dates parse the same everywhere.
  expect(os.locales.every(l => l === 'C')).toBe(true)
})

test('the user starting the same command in the same folder at the same moment is never claimed', async ($, on) => {
  const clock = world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    // The user's own terminal: same command, same folder, after the "before" look. Its environment shows
    // it was not started through this Claude Code. The agent's own never shows up.
    os.table.push({ pid: 520, ppid: 1, command: 'npm run dev', lstart: 'Thu Oct 2 10:00:00 2026', ports: [3001], cwd: '/repo', env: 'user' })
    return started
  })
  const ran = await $.tool.call(bg('npm run dev'))
  expect(contextOf(ran)).not.toMatch(/pid 520/)
  await clock.advance(61_000)
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  expect(os.kills.filter(k => k.pids.length > 0).length).toBe(0)
})

test('a process whose environment the OS hides is claimed only when it descends from Claude Code', async ($, on) => {
  const clock = world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 530, ppid: 1, command: 'python3 -m http.server 9000', lstart: 'Thu Oct 2 10:00:00 2026', ports: [9000], cwd: '/repo', env: 'hidden' })
    return started
  })
  await $.tool.call(bg('python3 -m http.server 9000'))
  await clock.advance(61_000)
  expect(await procsText($ as never)).toMatch(/no tracked processes are running/)
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  expect(killed(os, '-TERM')).toEqual([])
})

test('two servers started by one command each own only their own process', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 601, ppid: 1, command: 'python3 -m http.server 8000', lstart: 'Thu Oct 2 10:00:00 2026', ports: [8000], cwd: '/repo' })
    os.table.push({ pid: 602, ppid: 1, command: 'python3 -m http.server 8001', lstart: 'Thu Oct 2 10:00:00 2026', ports: [8001], cwd: '/repo' })
    return started
  })
  await $.tool.call(bg('python3 -m http.server 8000 & python3 -m http.server 8001 &'))
  const text = await procsText($ as never)
  expect(text).toMatch(/pid 601 on :8000/)
  expect(text).toMatch(/pid 602 on :8001/)
  expect(text).not.toMatch(/pid 601,602|pid 602,601/)
})

test('one command asking for the same port twice is refused before anything starts', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  let starts = 0
  on('tool.call', () => {
    starts += 1
    return started
  })
  const ran = await $.tool.call(bg('node api.js --port 3000 & node worker.js --port 3000 &'))
  expect(ran.deny).toMatch(/two things on port 3000/)
  expect(starts).toBe(0)
})

test('starting the same dev server again is refused, a different port is allowed', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  let starts = 0
  on('tool.call', (_$, e) => {
    starts += 1
    const port = (e as { command: string }).command.includes('8001') ? 8001 : 8000
    os.table.push({ pid: 600 + starts, ppid: 1, command: `python3 -m http.server ${port}`, lstart: `Thu Oct 2 11:00:0${starts} 2026`, ports: [port], cwd: '/repo' })
    return started
  })
  await $.tool.call(bg('python3 -m http.server 8000'))
  const again = await $.tool.call(bg('python3 -m http.server 8000'))
  expect(again.deny).toMatch(/port 8000/)
  const other = await $.tool.call(bg('python3 -m http.server 8001'))
  expect(other.deny).toBeUndefined()
  expect(starts).toBe(2)
})

test('the same package script through another package manager or with extra flags is a duplicate', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 640, ppid: 1, command: 'npm run dev', lstart: 'Thu Oct 2 10:00:00 2026', ports: [3000], cwd: '/repo' })
    return started
  })
  await $.tool.call(bg('npm run dev'))
  expect((await $.tool.call(bg('yarn dev'))).deny).toMatch(/already running/)
  expect((await $.tool.call(bg('npm run dev --host 0.0.0.0'))).deny).toMatch(/already running/)
})

test('a port held by a process the agent did not start is reported without its secrets', async ($, on) => {
  world(on)
  const os = fakeOs()
  os.table.push({ pid: 50, ppid: 1, command: 'node server.js --token=sekrit', lstart: 'Mon Sep 1 01:00:00 2026', ports: [3000], cwd: '/', env: 'user' })
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => started)
  const ran = await $.tool.call(bg('npm run dev -- --port 3000'))
  expect(ran.deny).toMatch(/pid 50/)
  expect(ran.deny).toMatch(/not started through this session/)
  expect(ran.deny).not.toMatch(/sekrit/)
})

test('stop sends SIGTERM only to the recorded tree, then SIGKILL only to members that are still the same process', async ($, on) => {
  const clock = world(on)
  const os = fakeOs()
  os.table.push({ pid: 900, ppid: 1, command: 'npm run dev', lstart: 'Wed Oct 1 09:00:00 2026', ports: [], cwd: '/repo', env: 'user' })
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 700, ppid: 1, command: 'npm run dev', lstart: 'Thu Oct 2 12:00:00 2026', ports: [4000], cwd: '/repo' })
    os.table.push({ pid: 701, ppid: 700, command: 'node next-server', lstart: 'Thu Oct 2 12:00:01 2026', ports: [], cwd: '/repo', stubborn: true })
    return started
  })
  await $.tool.call(bg('npm run dev'))
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  expect(killed(os, '-TERM').sort()).toEqual([700, 701])
  expect(killed(os, '-TERM')).not.toContain(900)
  // During the grace period the stubborn child exits and its pid is reused by an unrelated process.
  const i = os.table.findIndex(p => p.pid === 701)
  os.table.splice(i, 1, { pid: 701, ppid: 1, command: 'unrelated-daemon', lstart: 'Thu Oct 2 12:00:03 2026', ports: [], cwd: '/', env: 'user' })
  await clock.advance(5_000)
  expect(killed(os, '-KILL')).not.toContain(701)
})

test('a stubborn process that is still ours gets SIGKILL after the grace period', async ($, on) => {
  const clock = world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 720, ppid: 1, command: 'npm run dev', lstart: 'Thu Oct 2 12:10:00 2026', ports: [4100], cwd: '/repo', stubborn: true })
    return started
  })
  await $.tool.call(bg('npm run dev'))
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  expect(killed(os, '-KILL')).toEqual([])
  await clock.advance(3_500)
  expect(killed(os, '-KILL')).toEqual([720])
})

test('a child spawned during the grace period is killed too, and a respawn is reported, not called stopped', async ($, on) => {
  const clock = world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 740, ppid: 1, command: 'nodemon server.js', lstart: 'Thu Oct 2 12:20:00 2026', ports: [], cwd: '/repo', stubborn: true })
    return started
  })
  await $.tool.call(bg('nodemon server.js'))
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  // While SIGTERM is pending, nodemon forks a new child.
  os.table.push({ pid: 741, ppid: 740, command: 'node server.js', lstart: 'Thu Oct 2 12:20:02 2026', ports: [3000], cwd: '/repo', stubborn: true })
  await clock.advance(3_500)
  expect(killed(os, '-KILL').sort()).toEqual([740, 741])
  // A supervisor brings it straight back.
  os.table.push({ pid: 760, ppid: 1, command: 'nodemon server.js', lstart: 'Thu Oct 2 12:20:04 2026', ports: [], cwd: '/repo' })
  await clock.advance(2_000)
  expect(await procsText($ as never)).toMatch(/1 running/)
})

test('a recorded pid that now belongs to a different process is never signalled', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 800, ppid: 1, command: 'npm run dev', lstart: 'Thu Oct 2 13:00:00 2026', ports: [], cwd: '/repo' })
    return started
  })
  await $.tool.call(bg('npm run dev'))
  const p = os.table.find(x => x.pid === 800)
  if (p !== undefined) p.lstart = 'Thu Oct 2 14:00:00 2026'
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  expect(killed(os, '-TERM')).toEqual([])
})

test('when the launcher exits, the server it spawned is still tracked and stoppable', async ($, on) => {
  const clock = world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 1000, ppid: 1, command: 'npm run dev', lstart: 'Thu Oct 2 15:00:00 2026', ports: [], cwd: '/repo' })
    os.table.push({ pid: 1001, ppid: 1000, command: 'node server.js', lstart: 'Thu Oct 2 15:00:01 2026', ports: [3000], cwd: '/repo' })
    return started
  })
  await $.tool.call(bg('npm run dev'))
  // The npm wrapper exits; its server is reparented to launchd and keeps the port.
  os.table.splice(os.table.findIndex(p => p.pid === 1000), 1)
  const child = os.table.find(p => p.pid === 1001)
  if (child !== undefined) child.ppid = 1
  await clock.advance(16_000)
  await $.command.run({ command: 'procs', args: 'stop-all' } as never)
  expect(killed(os, '-TERM')).toEqual([1001])
})

test('two overlapping starts of the same server: the second is refused while the first is still starting', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  let starts = 0
  on('tool.call', () => {
    starts += 1
    return started
  })
  const first = $.tool.call(bg('npm run dev'))
  const second = $.tool.call(bg('npm run dev'))
  const results = await Promise.all([first, second])
  expect(starts).toBe(1)
  expect(results.filter(r => r.deny !== undefined).length).toBe(1)
})

test('a start that never shows a process stops blocking a retry after a short hold', async ($, on) => {
  const clock = world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  let starts = 0
  on('tool.call', () => {
    starts += 1
    return started
  })
  await $.tool.call(bg('npm run dev'))
  await clock.advance(16_000)
  expect((await $.tool.call(bg('npm run dev'))).deny).toBeUndefined()
  expect(starts).toBe(2)
})

test('a failed command leaves nothing reserved', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  let starts = 0
  on('tool.call', () => {
    starts += 1
    return { isError: true as const, result: 'boom', text: 'boom' }
  })
  await $.tool.call(bg('npm run dev'))
  const again = await $.tool.call(bg('npm run dev'))
  expect(again.deny).toBeUndefined()
  expect(starts).toBe(2)
})

test('a foreground command Claude Code moves to the background is tracked', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 1100, ppid: 1, command: 'node server.js', lstart: lst(Date.parse('2026-10-02T10:00:01Z')), ports: [3300], cwd: '/repo' })
    return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'auto', timedOutAfterMs: 120000 } }
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'node server.js' })
  expect(contextOf(ran)).toMatch(/pid 1100/)
})

test('ordinary commands are not touched', async ($, on) => {
  world(on)
  let calls = 0
  on('process.run', () => {
    calls += 1
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  const ran = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(ran.isError).toBeUndefined()
  expect(calls).toBe(0)
})

test('the band shows what is running and keeps other mods\' bands below it', async ($, on) => {
  world(on)
  const os = fakeOs()
  on('process.run', (_$, e) => ({ value: os.answer(e.argv, e.init) }))
  on('tool.call', () => {
    os.table.push({ pid: 510, ppid: 1, command: 'npm run dev', lstart: 'Thu Oct 2 10:05:00 2026', ports: [3000], cwd: '/repo' })
    return started
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>OTHER MOD</Text>
  })
  await $.tool.call(bg('npm run dev'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'process-concierge',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    } as never)
    expect(await ui.find({ type: 'Text', text: /1 running · :3000/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /OTHER MOD/ })).toBeDefined()
    await ui.unmount()
  }
})

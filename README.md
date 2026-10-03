# Process Concierge

A Claude Code mod that gives every dev server, watcher and background job the agent starts an owner, a port and a stop button, so abandoned processes stop piling up.

- **Runs what the agent starts under a supervisor.** A background job (`run_in_background`, a trailing `&`, `nohup`, or a known dev server or watcher) is launched through a small shell script, `bin/pc-run`, that leads a new process group for that job.
- **A band above the prompt:** `⚙ 2 running · :3000 :8081 · /procs`, drawn above any other mod's band.
- **`/procs`** opens a pane listing each job with its ports, age, process count, CPU, memory and folder, and a **stop** button. **Stop all from this session**, **stop earlier sessions' jobs** and **clear finished** sit at the top. `/procs stop-all` and `/procs clean` do the same from the prompt. Other listeners on the machine are listed below, for reference only.
- **No duplicates.** When the agent tries to start a dev server that is already running in the same folder, or on a port something already holds, the call is refused and the model is told what to reuse.
- **Jobs left over from earlier sessions** show up on the next start, and can still be stopped.

## How ownership works

Process Concierge doesn't guess which processes belong to a job. It makes each job's processes a group it can prove it owns:

1. **The command is rewritten to launch through the supervisor, and is never split.** The whole command line is handed unchanged to the supervisor, which runs it in your shell, so `node api.js & node worker.js` (in a `run_in_background` call) or `cd web && npm run dev` is one group with one stop button. A foreground line is wrapped when nothing in it is sent to the background, or when its only `&` is the one at the very end (`cd web && npm run dev > dev.log 2>&1 &`). Each supervisor has a random token.
2. **The supervisor checks in.** It uses `perl` (part of macOS) to put itself in a new process group it leads. Every helper it runs is called by absolute path (`/bin/ps`, `/bin/date`, …). It first clears what could make it run code your command never named: `PERL5OPT`/`PERL5LIB`, exported shell functions, and `SHELLOPTS`/`BASHOPTS` (an inherited job-control or errexit setting would otherwise move the job out of its group). It turns job control off itself too. Your job still gets `PERL5OPT` and `PERL5LIB` back. It writes its pid and start time to `~/.cache/process-concierge/ledger/<token>.run` (folder mode 700). It then runs the job in your own shell (`$SHELL` if it's zsh or bash, else `/bin/sh`; zsh runs with `-f`, so no startup files), with your stdin, umask and normal signal handling. It lets go of its own copies of your terminal output, so a caller waiting for output to end isn't held open, and it stays alive until every process in the group has exited.
3. **Stop never signals a pid from the mod.** Pressing stop writes `<token>.stop`. The supervisor sees it, sends `SIGTERM` to its own group, and after 3 seconds `SIGKILL`. It leads the group and is alive while it does this, so the group id can't belong to anything else. Before writing the stop file, the mod confirms the supervisor is still running, with the same pid and start time and its token in its command line.
4. **Stop is confirmed, not assumed.** A job is reported stopped only once its supervisor is gone. If it's still running after 12 seconds, the job goes back to running with a note. If processes of the group outlive the supervisor (for example a `sudo` child that ignores the signal), they're listed and left alone.

**Anything not launched through the supervisor is never stopped.** Your own servers on the machine are listed read-only. A line the mod can't read reliably runs exactly as written and is neither recorded nor refused, because refusing a command it can't read could block one that never starts a server:
- lines the shell would reject (`node app.js & &`, `npm run dev &&`)
- comments, backslash escapes, `$'…'` quoting, or quotes glued to other text (`set''sid`)
- subshells, groups, command substitutions, heredocs, or `if`/`for` blocks
- `exec`, `eval`, `source`, `cd -`, `pushd +N`, or a command word that is a variable (`$X dev`)
- any line that calls `setsid`, by path or inside double quotes too
- every job on a machine without `/usr/bin/perl`, `/usr/bin/env` or `/bin/ps`

A readable foreground line with an `&` in the middle (`npm run dev & sleep 2 && curl …`) can't be wrapped without changing what the call returns, so it runs as written with no stop button; it is still checked for duplicates.

**Task mode.** A `run_in_background` call, or a foreground long runner, ends when its launching shell goes away, so interrupting the call still stops the job. A job sent to the background with `&` keeps running after the call, as it would without the mod.

**Permissions.** The model asked for the original command, so your Bash permission rules apply to that command, not to the wrapper. The mod answers the permission check for a command it rewrote with the decision for the original, and only while that call is in flight.

Known dev servers and watchers are recognised by command:
- npm/pnpm/yarn/bun `dev`/`start`/`serve`/`watch`
- Vite, Next, Expo, Metro, webpack serve
- `tsc -w`, Jest and Vitest watch
- Rails, `python -m http.server`, uvicorn, Flask, Docker Compose, and more

Ports come from `lsof` (read every few seconds at most, and fresh when you open `/procs` or a job starts), so this targets macOS and Linux. The mod runs `ps`, `lsof` and `rm` by absolute system path, never through your `PATH`. Commands are stored with env assignments removed and secret-looking values hidden; the duplicate check keeps only a digest of the command.

Limits:
- A plain command that Claude Code moves to the background after a timeout wasn't launched under the supervisor, so it gets no stop button.
- A job that starts its own new session (`setsid` inside a script) leaves the group and isn't stopped with it.
- A supervised job runs in a fresh shell. Aliases, shell functions (including exported bash functions) and zsh startup files from your setup aren't available to it, though exported variables and your `PATH` are.
- Within one command, a job is checked for duplicates only against jobs of earlier lists sent to the background with `&`, or other commands of the same pipeline. `npm run dev || npm run dev &` is allowed; `npm run dev & npm run dev` is refused.
- A wrapped foreground list runs in the supervisor's shell, so a `cd` in it doesn't change the folder of later Bash calls (it wouldn't for a line ending in `&` either).
- `go run` and programs named `serve` are always treated as long runners, so a one-shot `go run ./migrate.go` is supervised like a server.

## What it hooks

Events this mod hooks, as `claude plugin validate` reads the module:

- `session.start`, `session.end`
- `command.run` for `/procs`
- `tool.check` for Bash: the permission decision for a rewritten command is the decision for the original
- `tool.call` for Bash: rewrites a job to launch under the supervisor, refuses duplicates, notes the job for the model
- `ui.render` for the AbovePrompt band and the `/procs` pane

Engine calls it makes: `$.process.run` (`ps`, `lsof`, `rm` of its own ledger files), `$.fs.read`/`$.fs.write`/`$.fs.list` (the ledger), `$.fs.stat`, `$.tool.check`, `$.store`, `$.state`, `$.clock`, `$.command.register`, `$.session.cwd`/`$.session.id`, `$.env.get` (HOME), `$.ui.open`/`$.ui.resolve`.

## Privacy

It runs entirely on your machine and sends nothing over the network. It runs `ps` and `lsof` to measure jobs, launches jobs through its own `bin/pc-run` script (which uses `perl` to start a process group), and keeps a small ledger of supervisor pids under `~/.cache/process-concierge`. Tracked jobs (command with secrets hidden, folder, ports) are kept in Claude Code's local plugin store so it can show leftovers from earlier sessions.

The mod collects no analytics or telemetry, and its author receives no data from it.

Full policy: [PRIVACY.md](PRIVACY.md).

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install process-concierge@ccdwyer-mods
/reload-plugins
```

## Develop

`bash tests/pc-run-real.sh` runs the supervisor for real (inherited job control, a hostile `PATH`/`PERL5OPT`, exit status); the plugin tests mock the OS.

```
claude plugin validate .
claude plugin test .
```

## License

MIT

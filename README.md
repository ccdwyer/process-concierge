# Process Concierge

A Claude Code mod that gives every dev server, watcher and background process the agent starts an owner, a port and a stop button, so abandoned processes stop piling up.

- **Tracks what the agent starts.** Commands run in the background (`run_in_background`, a trailing `&`, `nohup`, or a foreground command that times out and is moved to the background) are matched to the processes they started, with their listening ports.
- **A band above the prompt:** `⚙ 2 running · :3000 :8081 · /procs`, drawn above any other mod's band.
- **`/procs`** opens a pane: each process with its pids, ports, age, CPU, memory and folder, and a **stop** button. **Stop all from this session**, **clean up earlier sessions** and **clear finished** sit at the top. `/procs stop-all` and `/procs clean` do the same from the prompt.
- **No duplicates.** When the agent tries to start a dev server that is already running in the same folder, or on a port a tracked process already holds, the call is refused and the model is told the pid and port to reuse.
- **Leftovers from earlier sessions** show up as such on the next start, with one-click cleanup.

## Safety

- **Only processes it can prove the agent started.** Claude Code stamps every process its tools start with its own pid and session id in the environment, and that stamp survives the launcher exiting. A new process counts as the agent's only if it appeared after the command ran, its command line matches the job (program, script or path, and a port given on the command line), it is not already another job's, and it either descends from this Claude Code process or carries that stamp. The folder a process runs in is never proof on its own, so the same command you start yourself in your own terminal, in the same folder at the same moment, is not claimed. Where macOS hides a process's environment (its own signed binaries) and it is not a descendant, the entry is marked unconfirmed and gets no stop button.
- **Every signal is identity-checked.** Each process in a tracked tree is recorded with its start time. `SIGTERM`, and `SIGKILL` three seconds later for whatever is still running (children it spawned during the grace period included), are sent by a small script that re-reads each pid's start time immediately before signalling it and skips any that changed. That narrows the pid-reuse window to the gap between two shell commands; start times have one-second precision, so a pid reused within the same second as the original started is the one case it cannot tell apart. A stop is reported as done only once the processes are confirmed gone. If something restarts the process during the stop, it is reported as running again; if the process list can't be read, the stop button comes back.
- **Servers that outlive their launcher stay tracked.** When `npm`, `npx` or a shell wrapper exits and its server keeps running, the server is still tracked and stoppable.
- **Duplicates are refused before they start.** The check and the reservation happen in one step, so two overlapping starts can't both pass. A command asking for a port that something else already holds is refused with the pid that holds it, even if the agent didn't start it. The same command on a different port is allowed.

Known dev servers and watchers are recognised by command (npm/pnpm/yarn/bun `dev`/`start`/`serve`/`watch`, Vite, Next, Expo, Metro, webpack serve, `tsc -w`, Jest and Vitest watch, Rails, `python -m http.server`, uvicorn, Flask, Docker Compose and more), as is anything sent to the background. Detection and ports use `ps` and `lsof`, so this targets macOS and Linux. Commands are stored with env assignments removed and secret-looking values (flags, assignments, URL passwords, quoted values included) hidden; the duplicate check keeps only a digest of the command, never its arguments.

## What it hooks

Events this mod hooks, as `claude plugin validate` reads the module:

- `session.start`
- `session.end`
- `command.run{command=procs}`
- `tool.call{tool=Bash}`
- `ui.render{component=AbovePrompt}`
- `ui.render{component=Pane`
- `requestId=process-concierge}`

Engine calls it makes: `$.clock.after (via stopProc`, `track)`, `$.clock.every (via startTicker)`, `$.clock.now (via publish`, `refresh`, `track)`, `$.command.register`, `$.process.run (via run)`, `$.session.cwd`, `$.session.id`, `$.state.get`, `$.state.set (via publish)`, `$.store.delete (via forget)`, `$.store.get (via loadStore)`, `$.store.keys (via loadStore)`, `$.store.set (via persist)`, `$.ui.open`, `$.ui.resolve`.

A `tool.call` hook sits in the middle of every tool call: it can see the call, refuse it, or add context to its result. This mod uses that only for the behaviour described above.

## Privacy

It runs entirely on your machine and sends nothing over the network. It runs `ps`, `lsof` and `kill` locally to find, measure and stop the processes the agent started. The list of tracked processes (command, folder, pids, ports) is kept in Claude Code's local plugin store so it can show leftovers from earlier sessions.

The mod collects no analytics or telemetry, and its author receives no data from it.

Full policy: [PRIVACY.md](PRIVACY.md).

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install process-concierge@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```

## License

MIT

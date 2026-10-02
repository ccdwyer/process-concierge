# Privacy

Process Concierge runs entirely on your machine and sends nothing over the network.

- It launches the background jobs the agent starts through its own script, `bin/pc-run`. The script uses `perl` to put each job in its own process group, and stops that group only when you ask.
- It runs `/bin/ps` and `lsof` locally to measure those jobs, and `rm` only on its own ledger files.
- It keeps a ledger of supervisor pids and start times in `~/.cache/process-concierge/ledger`, a folder only you can read.
- Tracked jobs (command with env assignments and secret-looking values hidden, folder, ports) are kept in Claude Code's local plugin store so leftovers from earlier sessions can be shown.

The mod collects no analytics or telemetry, and its author receives no data from it.

Questions: https://github.com/ccdwyer/process-concierge/issues

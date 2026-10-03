#!/bin/bash
# Real-shell check of bin/pc-run (the plugin test kit mocks the OS and never runs it).
# Run: bash tests/pc-run-real.sh   — exits 0 when every check passes.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
fail=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; fail=1; fi; }
token() { /usr/bin/od -An -N12 -tx1 /dev/urandom | /usr/bin/tr -d ' \n'; }
wait_for() { for _ in $(seq 1 40); do eval "$1" && return 0; sleep 0.25; done; return 1; }

# 1. Inherited SHELLOPTS=monitor (job control) and errexit must not pull the job out of the supervisor's group.
tok=$(token)
( set -m -e; export SHELLOPTS; /bin/sh "$here/bin/pc-run" "$tok" "$dir" detached /bin/sh -- "sleep 41$RANDOM" & )
check "supervisor checks in" "wait_for '[ -s \"$dir/$tok.run\" ]'"
sup=$(sed -n 's/^pid=//p' "$dir/$tok.run")
job=$(ps -A -o pid=,pgid=,command= | awk -v s="$sup" '$2==s && $3=="sleep" {print $1}' | head -1)
check "the job shares the supervisor's process group (SHELLOPTS=monitor inherited)" "[ -n \"$job\" ]"
touch "$dir/$tok.stop"
check "a stop file ends the job" "wait_for '! kill -0 ${job:-999999} 2>/dev/null'"
check "the supervisor records the stop" "wait_for 'grep -q exit=stopped \"$dir/$tok.exit\" 2>/dev/null'"

# 2. A shadow `ps` on PATH and a hostile PERL5OPT never run during supervision.
tok=$(token)
mkdir -p "$dir/shadow"; printf '#!/bin/sh\ntouch "%s/shadow-ran"\nexit 0\n' "$dir" > "$dir/shadow/ps"; chmod +x "$dir/shadow/ps"
( export PATH="$dir/shadow:$PATH" PERL5OPT=-Mnonexistent_evil; /bin/sh "$here/bin/pc-run" "$tok" "$dir" detached /bin/sh -- "sleep 42$RANDOM" & )
check "supervisor checks in with a hostile PATH and PERL5OPT" "wait_for '[ -s \"$dir/$tok.run\" ]'"
touch "$dir/$tok.stop"
check "it stops" "wait_for 'grep -q exit=stopped \"$dir/$tok.exit\" 2>/dev/null'"
check "the shadow ps never ran" "[ ! -e \"$dir/shadow-ran\" ]"

# 3. Task mode passes the job's exit status through.
tok=$(token)
/bin/sh "$here/bin/pc-run" "$tok" "$dir" task /bin/sh -- 'exit 7'; code=$?
check "task mode returns the job's exit status" "[ $code = 7 ]"

rm -rf "$dir"
exit $fail

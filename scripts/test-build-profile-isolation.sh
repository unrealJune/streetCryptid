#!/usr/bin/env bash

# Offline proof that the build profiler cannot publish anything it read.
#
# scripts/build-profile.sh samples the process table WHILE `eas build --local` is running, and that
# build's child processes carry signing credentials in their argument vectors. The sampler is
# written so those bytes are never read (it reads `comm`, not `args`) and never echoed (a closed
# vocabulary with no default branch). This test is what makes that claim checkable instead of a
# comment, and it runs anywhere bash does -- no runner, no network, no EAS.
#
# The method is to replace `ps` with a fake that returns input far more hostile than a real process
# table ever would: a credential sentinel, workflow-command spoofs, shell metacharacters, ANSI
# escapes, and an over-long line. Then every artifact the profiler produces, and the rendered
# summary, must be free of all of it.
#
# A leak test that passes because nothing was sampled is worthless, so there is a positive control:
# the report must still contain the tools the fake `ps` legitimately reported.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/streetcryptid-profile-test.XXXXXX")"

# Distinctive enough that a substring match cannot be a coincidence. Stands in for the base64 job
# blob EAS puts on its child's argv.
sentinel='U0lHTklOR19DUkVERU5USUFMX01VU1RfTkVWRVJfQkVfUFVCTElTSEVE'

cleanup() {
  if [[ -d "$test_root" ]]; then
    chmod -R u+w "$test_root" 2> /dev/null || true
    rm -rf -- "$test_root"
  fi
}
trap cleanup EXIT

export SC_BUILD_PROFILE_DIR="$test_root/profile"
export SC_PROFILE_SAMPLE_INTERVAL=1

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# --- A deliberately hostile process table ------------------------------------

mkdir -p "$test_root/bin"
long_name="$(printf 'A%.0s' $(seq 1 5000))"
cat > "$test_root/bin/ps" << EOF
#!/usr/bin/env bash
# Everything a real \`ps\` could hand us, plus everything it could not.
cat <<'NAMES'
/usr/bin/cargo
cargo
rustc
/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild
java
node
eas build --local --profile production-internal-ios --credentials $sentinel
$sentinel
/usr/bin/cargo --token=$sentinel
cargo $sentinel
\$(touch $test_root/pwned)
\`touch $test_root/pwned2\`
::add-mask::$sentinel
::error::spoofed annotation
;rm -rf $test_root/victim
../../etc/passwd
$(printf '\033[31mred\033[0m')
$long_name
NAMES
EOF
chmod 700 "$test_root/bin/ps"

export PATH="$test_root/bin:$PATH"

# --- 0. These scripts must run on the macOS build runner ---------------------

# The iOS build job runs them with /bin/bash, which on macOS is 3.2 -- Apple never shipped a GPLv3
# bash. A bash 4 construct there is a SYNTAX error, not a wrong answer, so it takes out the step
# before any assertion in this file gets a chance to run. A grep is the only way to catch that from
# a machine that has a modern bash, and it is worth catching: the alternative is finding out
# fifteen minutes into a build job.
for script in build-profile.sh build-report.sh; do
  # Comment lines are stripped first, or the comment explaining this rule trips it.
  if grep -v '^[[:space:]]*#' "$repo_root/scripts/$script" |
    grep -nE '(declare|local)[[:space:]]+-A|mapfile|readarray|\$\{[A-Za-z_]+(,,|\^\^)\}'; then
    fail "$script uses a bash 4 construct; the macOS runner's /bin/bash is 3.2"
  fi
done

# shellcheck source=scripts/build-profile.sh
source "$repo_root/scripts/build-profile.sh"

sc_profile_reset

# --- 1. The sampler ----------------------------------------------------------

sc_profile_sample_once >> "$(sc_profile_sample_file)"

sample_file="$(sc_profile_sample_file)"
[[ -s "$sample_file" ]] || fail "the sampler produced no output at all (the fake ps is not wired up)"

# The strongest available invariant, and the one worth stating plainly: EVERY line the sampler
# writes must be one of its own two record kinds followed by a word from its own vocabulary. If
# this holds, no byte of the process table can be in the file, whatever the process table said.
record_re=$'^[cw]\t[a-z][a-z0-9]{0,31}$'
while IFS= read -r line; do
  [[ "$line" =~ $record_re ]] ||
    fail "the sampler wrote a record outside its own vocabulary"
done < "$sample_file"

for artifact in "$sample_file"; do
  if grep -Fq "$sentinel" "$artifact"; then
    fail "the credential sentinel reached $artifact"
  fi
done

# Nothing was evaluated: a name shaped like a command substitution stayed a string.
[[ ! -e "$test_root/pwned" && ! -e "$test_root/pwned2" ]] ||
  fail "a process name was evaluated as shell"

# Positive control. Without this the test would pass just as happily on a sampler that wrote
# nothing, which is exactly the bug that would make every other assertion meaningless.
for expected in cargo rustc xcodebuild gradle node; do
  grep -q "	$expected\$" "$sample_file" ||
    fail "the sampler missed $expected — the leak assertions above proved nothing"
done

# A name that merely CONTAINS a known tool is not that tool, or the vocabulary would be a
# substring match and the rest of the line could ride along with it. The fake process table has two
# real cargo processes (one by path, one bare) and three impostors carrying the sentinel.
#
# The counts also pin the two record kinds apart: two `c` rows for the two processes, one `d`
# deduplicated `w` row for the instant. That dedup is a `sort -u` rather than an associative array
# because the macOS runner's bash is 3.2, so it is worth an assertion of its own.
cargo_cpu="$(grep -c '^c	cargo$' "$sample_file" | tr -d '[:space:]')"
cargo_wall="$(grep -c '^w	cargo$' "$sample_file" | tr -d '[:space:]')"
[[ "$cargo_cpu" == '2' ]] ||
  fail "expected two cargo processes, got $cargo_cpu (matching is not anchored)"
[[ "$cargo_wall" == '1' ]] ||
  fail "expected one deduplicated cargo wall record, got $cargo_wall"

# --- 2. The phase and note writers reject hostile records --------------------

sc_profile_mark "phase-$sentinel" 12
sc_profile_mark 'cargo-build' "$sentinel"
sc_profile_mark '../../escape' 5
sc_profile_mark 'cargo-build' 61
sc_profile_note "note-$sentinel" ok
sc_profile_note 'native_artifacts' "$sentinel"
sc_profile_note 'native_artifacts' 'reused-abc123'

phase_file="$(sc_profile_phase_file)"
meta_file="$(sc_profile_meta_file)"

for artifact in "$phase_file" "$meta_file"; do
  [[ -s "$artifact" ]] || fail "$artifact was never written"
  grep -Fq "$sentinel" "$artifact" && fail "the credential sentinel reached $artifact"
done

grep -q '^cargo-build	61$' "$phase_file" || fail "a valid phase mark was rejected"
grep -q '^native_artifacts	reused-abc123$' "$meta_file" || fail "a valid note was rejected"

# --- 3. The renderer drops what a compromised producer could have written ----

# Everything above proves the producers are clean. This proves the renderer does not depend on
# that: poison the files directly, the way a future change to build-profile.sh might.
printf 'stolen\t%s\n' "$sentinel" >> "$phase_file"
printf '%s\t1\n' "$sentinel" >> "$phase_file"
printf 'x\ty\tz%s\n' "$sentinel" >> "$phase_file"
printf 'c\t%s\n' "$sentinel" >> "$sample_file"
printf 'w\t%s\n' "$sentinel" >> "$sample_file"
printf 'native_artifacts\t%s\n' "$sentinel" >> "$meta_file"

report="$test_root/report.md"
SC_BUILD_SECONDS=1277 \
  SC_CACHE_JS_HIT=true \
  SC_CACHE_CARGO_HIT=false \
  SC_CACHE_NATIVE_HIT="$sentinel" \
  SC_CACHE_GRADLE_HIT=true \
  bash "$repo_root/scripts/build-report.sh" android > "$report"

grep -Fq "$sentinel" "$report" && fail "the credential sentinel reached the rendered summary"

# The summary is published to a public run page, so it must also not be able to forge the workflow
# commands the runner parses, or an escape sequence that hides content from a reader.
grep -q '^::' "$report" && fail "the summary could forge a workflow command"
grep -q $'\033' "$report" && fail "the summary carried an ANSI escape"

# The renderer must SAY it dropped things rather than silently swallowing them: a summary that
# quietly discards malformed records hides the very tampering it is guarding against.
grep -q 'malformed profile record' "$report" ||
  fail "the renderer discarded poisoned records without reporting it"

# An unrecognized cache value is reported as unknown, never echoed.
grep -q 'unknown' "$report" || fail "a hostile cache value was not reported as unknown"

# Positive control again: the report has to be a real report.
grep -q 'cargo-build' "$report" || fail "the report lost its measured phases"
grep -q '1m 01s' "$report" || fail "the report did not format a measured duration"
grep -q '21m 17s' "$report" || fail "the report did not format the build duration"

echo "Build profiling published only its own vocabulary: the sampler wrote no byte of the process table, the writers rejected hostile records, and the renderer dropped and reported poisoned ones."

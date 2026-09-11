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

# --- 3b. The build tools' own instrumentation ---------------------------------
#
# The sampler is ours; these three are not. cargo, Gradle and Xcode each produce their own
# performance data, which is far better than sampling for the phases they own -- and each is a new
# path into a public job summary, so each gets the same treatment: legitimate rows must survive,
# and anything carrying the sentinel must not.

# cargo build --timings. The parser is handed a report whose crate names are hostile. Note the
# report also carries a full command line, which is where cargo records how it was invoked.
cat > "$test_root/cargo-timing.html" << EOF
<html><script>
const UNIT_DATA = [
  {
    "i": 0,
    "name": "iroh",
    "version": "1.0.2",
    "mode": "todo",
    "start": 0.0,
    "duration": 61.5
  },
  {
    "i": 1,
    "name": "$sentinel",
    "version": "1.0.0",
    "mode": "todo",
    "start": 1.0,
    "duration": 9.0
  },
  {
    "i": 2,
    "name": "not a crate name; $sentinel",
    "version": "1.0.0",
    "mode": "todo",
    "start": 2.0,
    "duration": 8.0
  }
];
const COMMAND = "cargo build --release --credentials $sentinel";
</script></html>
EOF

crates_file="$SC_BUILD_PROFILE_DIR/crates.tsv"
if command -v node > /dev/null 2>&1; then
  node "$repo_root/scripts/parse-cargo-timings.mjs" "$test_root/cargo-timing.html" > "$crates_file"
  [[ -s "$crates_file" ]] || fail "the cargo timings parser produced nothing for a valid report"
  grep -q '^iroh	61500$' "$crates_file" || fail "the cargo timings parser dropped a real crate"
  grep -Fq "$sentinel" "$crates_file" &&
    fail "the cargo timings parser published a crate name carrying the sentinel"
  # A report it cannot parse must yield silence, not a guess.
  printf 'not html at all\n' > "$test_root/garbage.html"
  [[ -z "$(node "$repo_root/scripts/parse-cargo-timings.mjs" "$test_root/garbage.html")" ]] ||
    fail "the cargo timings parser invented output for an unparseable report"
else
  printf 'iroh\t61500\n_unit_ms\t61500\n_wall_ms\t61500\n' > "$crates_file"
fi
# ...and the renderer must not trust the parser either.
printf '%s\t100\n' "$sentinel" >> "$crates_file"
printf 'iroh-blobs\t%s\n' "$sentinel" >> "$crates_file"

# Gradle task outcomes, written by scripts/gradle-build-profile.init.gradle.
printf ':app:compileReleaseKotlin\tEXECUTED\t44000\n' > "$SC_BUILD_PROFILE_DIR/gradle-tasks.tsv"
printf ':app:mergeReleaseResources\tFROM-CACHE\t1200\n' >> "$SC_BUILD_PROFILE_DIR/gradle-tasks.tsv"
printf ':app:%s\tEXECUTED\t1\n' "$sentinel" >> "$SC_BUILD_PROFILE_DIR/gradle-tasks.tsv"
printf ':app:x\t%s\t1\n' "$sentinel" >> "$SC_BUILD_PROFILE_DIR/gradle-tasks.tsv"
printf ':app:y\tEXECUTED\t%s\n' "$sentinel" >> "$SC_BUILD_PROFILE_DIR/gradle-tasks.tsv"

# Xcode's timing summary. This is the riskiest source by far: it is extracted from fastlane's raw
# xcodebuild log, which really does contain the signing identity and provisioning profile. The log
# below is shaped like the real thing -- a CodeSign block around the summary -- and only the
# summary's fixed-shape lines may survive.
mkdir -p "$test_root/xcode-buildlog"
cat > "$test_root/xcode-buildlog/streetCryptid-streetCryptid.log" << EOF
CodeSign /Users/runner/work/build/streetCryptid.app (in target 'streetCryptid')
    cd /Users/runner/work/ios
    export CODESIGN_ALLOCATE=/usr/bin/codesign_allocate
/usr/bin/codesign --force --sign $sentinel --entitlements app.xcent --timestamp=none
Provisioning profile: "streetCryptid AdHoc" ($sentinel)

Build Timing Summary

CompileSwiftSources (42 tasks) | 218.443 seconds
PhaseScriptExecution (11 tasks) | 96.010 seconds
CompileC (7 tasks) | 31.200 seconds
Ld (3 tasks) | 12.750 seconds
EvilPhase; echo $sentinel (1 task) | 1.000 seconds
$sentinel (1 task) | 2.000 seconds
EOF

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

# ...including everything the build tools reported about themselves.
grep -q 'iroh' "$report" || fail "the report lost the cargo timings"
grep -q 'FROM-CACHE' "$report" || fail "the report lost the Gradle task outcomes"
grep -q 'compileReleaseKotlin' "$report" || fail "the report lost the slowest Gradle task"

# --- 4. The iOS report, where Xcode's build log is read ----------------------

ios_report="$test_root/report-ios.md"
bundle="$test_root/bundle-ios"
# Raw cargo output sitting in the collection directory, to prove the bundle step refuses it.
cp "$test_root/cargo-timing.html" "$SC_BUILD_PROFILE_DIR/cargo-timing.html"
SC_BUILD_SECONDS=985 \
  SC_CACHE_JS_HIT=true \
  SC_CACHE_CARGO_HIT=true \
  SC_CACHE_NATIVE_HIT=true \
  SC_CACHE_PODS_HIT=false \
  SC_XCODE_BUILDLOG_DIR="$test_root/xcode-buildlog" \
  SC_PROFILE_BUNDLE_DIR="$bundle" \
  bash "$repo_root/scripts/build-report.sh" ios > "$ios_report"

# The signing identity and the provisioning profile UUID sat three lines above the data that WAS
# extracted. If the extractor were line-loose in any way, this is where it would show.
grep -Fq "$sentinel" "$ios_report" &&
  fail "the credential sentinel reached the rendered summary from the Xcode build log"
grep -q 'codesign\|Provisioning' "$ios_report" &&
  fail "the Xcode build log's signing lines reached the rendered summary"
grep -q '^::' "$ios_report" && fail "the iOS summary could forge a workflow command"

grep -q 'CompileSwiftSources' "$ios_report" ||
  fail "the Xcode timing summary was not extracted — the assertions above proved nothing"
grep -q '3m 38s' "$ios_report" || fail "the Xcode phase duration was not formatted"
grep -q 'EvilPhase' "$ios_report" && fail "a malformed Xcode phase line was accepted"

# --- 5. The uploaded artifact ------------------------------------------------
#
# The job summary is not the only thing published: the workflow uploads a bundle. The renderer
# being careful is no help if the upload walks around it, which is what the first version of this
# change did -- it uploaded the collection directory itself. So the bundle is asserted on its own
# terms: built from validated rows, and containing no raw tool output.
[[ -d "$bundle" ]] || fail "no upload bundle was produced"
if grep -rFq "$sentinel" "$bundle" 2> /dev/null; then
  fail "the credential sentinel reached the uploaded artifact bundle"
fi
[[ -f "$bundle/cargo-timing.html" ]] &&
  fail "raw cargo output was copied into the uploaded bundle"
for expected in phases.tsv crates.tsv gradle-tasks.tsv xcode-phases.tsv; do
  [[ -s "$bundle/$expected" ]] ||
    fail "the bundle is missing $expected — the assertions above proved nothing"
done
grep -q '^iroh	61500$' "$bundle/crates.tsv" || fail "the bundle lost the cargo timings"
grep -q 'FROM-CACHE' "$bundle/gradle-tasks.tsv" || fail "the bundle lost the Gradle outcomes"
grep -q '^CompileSwiftSources	42	218$' "$bundle/xcode-phases.tsv" ||
  fail "the bundle lost the Xcode phases (a BSD/GNU split in the extractor would look like this)"

echo "Build profiling published only its own vocabulary: the sampler wrote no byte of the process table, the writers rejected hostile records, and the renderer dropped and reported poisoned ones."

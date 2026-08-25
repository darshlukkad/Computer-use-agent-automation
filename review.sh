#!/usr/bin/env bash
#
# A guided tour for someone assessing this, in about four minutes.
#
#   ./review.sh            run everything
#   ./review.sh --pause    stop between sections so there is time to read
#
# It makes a claim, runs the command that would falsify it, and shows the output.
# Nothing is simulated: every replay below drives a real browser against the real
# ParaBank container. It exits non-zero if any claim fails, so it doubles as a smoke
# test — a green run means the repository does what its README says.
#
# Nothing here needs a model API key. That is the point of the architecture rather
# than a convenience: the capabilities were learned once, and replaying them costs
# nothing per run.

set -uo pipefail

cd "$(dirname "$0")"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; CYAN=""; RESET=""
fi

PAUSE=0
[ "${1:-}" = "--pause" ] && PAUSE=1

FAILED=0
SECTION=0

section() {
  SECTION=$((SECTION + 1))
  printf '\n%s────────────────────────────────────────────────────────────%s\n' "$DIM" "$RESET"
  printf '%s%d. %s%s\n' "$BOLD" "$SECTION" "$1" "$RESET"
  [ $# -gt 1 ] && printf '   %s\n' "$2"
  printf '\n'
}

# The claim being tested, in the imperative, so a failure reads as a broken promise.
claim() { printf '%s   ▸ %s%s\n' "$CYAN" "$1" "$RESET"; }
run()   { printf '%s     $ %s%s\n' "$DIM" "$1" "$RESET"; }
pass()  { printf '     %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
fail()  { printf '     %s✗%s %s\n' "$RED" "$RESET" "$1"; FAILED=$((FAILED + 1)); }

wait_for_reader() {
  [ "$PAUSE" = "1" ] || return 0
  printf '\n%s     [enter to continue]%s' "$DIM" "$RESET"
  read -r _ </dev/tty || true
}

# Assert that a command's output contains a pattern, showing the interesting lines.
expect() {
  local description="$1" pattern="$2" show="$3"; shift 3
  local output
  output="$("$@" 2>&1)"
  if grep -qE "$pattern" <<<"$output"; then
    grep -E "$show" <<<"$output" | sed 's/^/       /'
    pass "$description"
  else
    fail "$description"
    sed 's/^/       /' <<<"$output" | tail -20
  fi
}

# --- preflight -------------------------------------------------------------

printf '\n%sComputer-use automation — review%s\n' "$BOLD" "$RESET"
printf 'Every claim below is checked against a live run. About four minutes.\n'

if ! curl -s -o /dev/null --max-time 3 http://localhost:8080/parabank/index.htm; then
  printf '\n%sParaBank is not running.%s Start everything with:\n\n    ./run.sh setup\n\n' "$RED" "$RESET"
  exit 1
fi

# ---------------------------------------------------------------------------

section "What exists" \
        "Three capabilities, each produced by a live model-driven run against ParaBank."
run "npm run cua -- list"
npm run --silent cua -- list 2>/dev/null | sed 's/^/       /'
claim "Risk is derived from the steps, not declared — a flow that moves money says so."
wait_for_reader

# ---------------------------------------------------------------------------

section "The central boundary" \
        "Production replay must never be able to consult a model. That is a claim about
   the import graph, so it is tested rather than asserted."
run "node --test tests/architecture.test.ts"
expect "no model SDK is reachable from the replay engine" \
       "^# fail 0" "^ok [0-9]+" \
       node --import tsx --test tests/architecture.test.ts
claim "The same test proves only src/surface/web/ knows what a browser is."
wait_for_reader

# ---------------------------------------------------------------------------

section "Replay, with no model in the loop" \
        "An input the learning run never saw. No API key is set for any of this."
run "npm run replay -- --id account.lookup_balance --input '{\"account_number\":\"12567\"}'"
expect "a capability replays and states its own result" \
       "^SUCCESS" "^SUCCESS|The current balance|^  [a-z_]+ = " \
       npm run --silent replay -- --id account.lookup_balance --input '{"account_number":"12567"}'
claim "The sentence comes from the artifact, so the wording is reviewable in the same diff
     as the flow that produced it."
wait_for_reader

# ---------------------------------------------------------------------------

section "The rung that answered" \
        "ParaBank's login fields have no id, no label and no accessible name, so
   getByRole(name:) and getByLabel both find nothing. The ladder is load-bearing."
run "npm run replay -- ... (the per-step trace)"
expect "every step reports which rung resolved it, and its drift" \
       "s2_fill_username" "step  +outcome|s[0-9]_" \
       npm run --silent replay -- --id account.lookup_balance --input '{"account_number":"13122"}'
claim "rung 2/2 means the caption rung resolved and that is what was recorded at learning
     time — so it is healthy, not degraded. Measuring drift against rung 1 would cry wolf
     on every run forever."
wait_for_reader

# ---------------------------------------------------------------------------

section "A negative answer is not an error" \
        "Account 99999 does not exist. The automation worked perfectly."
run "npm run replay -- --id account.lookup_balance --input '{\"account_number\":\"99999\"}'"
expect "a missing record is a business outcome with its own result variant" \
       "BUSINESS OUTCOME: ACCOUNT_NOT_FOUND" "BUSINESS OUTCOME|No account" \
       npm run --silent replay -- --id account.lookup_balance --input '{"account_number":"99999"}'
claim "That rule was not written by hand. 'cli probe' drove the capability into the branch
     twice — once with inputs that work, once with inputs that do not — and derived the
     rule from the difference. It is the only place verified:true is ever set."
wait_for_reader

# ---------------------------------------------------------------------------

section "Refusing is not failing" \
        "Same artifact, same inputs, same code — a different policy file."
run "npm run replay -- ... --policy evidence/policy-wrong-environment.json"
expect "a deployment policy refuses a capability aimed at the wrong host" \
       "BLOCKED by policy-origin-allowlist" "BLOCKED|outside the deployment" \
       npm run --silent replay -- --id account.lookup_balance \
         --input '{"account_number":"13122"}' \
         --policy evidence/policy-wrong-environment.json
claim "Nothing was attempted, so the remedy is review rather than debugging. policy.json is
     the whole guardrail surface: which risk classes need a signature, which origins this
     deployment permits, which pii tags are regulated."
wait_for_reader

# ---------------------------------------------------------------------------

section "Approval means something" \
        "Approval is a SHA-256 over canonical JSON, bound to the bytes."
run "node --test tests/artifact.test.ts  (the approval group)"
expect "editing an approved artifact invalidates it; flipping status by hand does not pass" \
       "^# fail 0" "editing an approved|flipping status|digest ignores key order" \
       node --import tsx --test tests/artifact.test.ts
claim "A formatter reordering keys does not break a valid approval; raising maxAttempts does."
wait_for_reader

# ---------------------------------------------------------------------------

section "Nothing regulated reaches disk" \
        "The caller gets the real answer. The evidence file gets a fingerprint."
# Its own run, into its own directory. Picking "the most recent evidence directory"
# looked fine and was not: the newest was the policy-blocked run from section 6, which
# never reaches an account and so contains no account number to find. The check passed
# for a reason that had nothing to do with masking.
TOUR_EVIDENCE="$(mktemp -d)"
run "npm run replay -- --id account.lookup_balance --input '{\"account_number\":\"13122\"}'"
npm run --silent replay -- --id account.lookup_balance \
  --input '{"account_number":"13122"}' --evidence-root "$TOUR_EVIDENCE" >/dev/null 2>&1
RESULT="$(find "$TOUR_EVIDENCE" -name result.json | head -1)"

if [ -z "$RESULT" ]; then
  fail "no result.json was written"
elif ! grep -q '"status": "success"' "$RESULT"; then
  fail "that run did not succeed, so there is nothing to check"
elif grep -q "13122" "$RESULT"; then
  fail "the account number reached $RESULT"
else
  printf '       on screen and to the caller: %s\n' "$(
    npm run --silent replay -- --id account.lookup_balance \
      --input '{"account_number":"13122"}' 2>&1 | grep -oE 'The current balance[^$]*\$[0-9,.]+' | head -1
  )"
  printf '       written to disk:             %s\n' \
    "$(grep -o '"answer": "[^"]*"' "$RESULT" | cut -d'"' -f4)"
  pass "the answer persists with the identifier masked"
fi
rm -rf "$TOUR_EVIDENCE"
claim "Masking happens once, at the write, over everything the recorder touches — the trace,
     the log, and the page observations inside them. A caller cannot forget to redact
     what it never handles."
wait_for_reader

# ---------------------------------------------------------------------------

section "The whole suite" \
        "100 tests. The integration ones drive a real browser against a real application,
   because a stubbed page would let this repository grade its own homework."
run "npm test"
expect "the full suite passes" "^# fail 0" "^# (tests|pass|fail)" npm test
wait_for_reader

# ---------------------------------------------------------------------------

printf '\n%s────────────────────────────────────────────────────────────%s\n' "$DIM" "$RESET"
if [ "$FAILED" -eq 0 ]; then
  printf '%sAll %d sections passed.%s\n' "$GREEN" "$SECTION" "$RESET"
else
  printf '%s%d of %d sections failed.%s\n' "$RED" "$FAILED" "$SECTION" "$RESET"
fi

cat <<EOF

  Not covered here, because they need a person at the keyboard:

    npm start                   the operator console — discovery, and a guided
                                walkthrough of a human taking the live browser
                                mid-run and handing it back

  Worth reading:

    REPORT.md                   the design, and what was cut and why
    evidence/README.md          real runs: discovery, a business outcome, a policy
                                refusal, and a handoff with its custody record
    capabilities/*.json         what a learned flow actually looks like
    context/REPO_ANALYSIS.md    a teardown of five other attempts at this brief,
                                and what this one does differently
EOF

exit $((FAILED > 0))

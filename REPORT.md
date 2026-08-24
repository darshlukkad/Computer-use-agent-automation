# Report

## 1. Architecture

Four phases; the boundary between the second and third is the design.

**Discovery** gives a model a goal in English, a live browser, and a closed action vocabulary —
click, fill, select, read, done, stuck. It never sees Playwright and never emits a selector.
Each turn it gets an observation (URL, title, an accessibility-shaped node list, visible text,
open dialogs) and names a control the way a person would: "the textbox captioned *Password*".
We synthesise the locator ladder from that and **measure which rung actually resolves**.

**Compilation** turns the trace into an artifact. Checkpoints are derived by diffing the page
before and after each action, so the model is never asked to invent a success condition.
Parameters come from provenance — the caller said `account_number` was `13122`, so we replace
that literal where it was actually typed — not from searching the trace for something
id-shaped, which would also rewrite an account number that merely appeared in a table.

**Replay** executes the artifact: policy → precondition → resolve → act → postcondition, with
retries gated on what the step does to the world rather than on attempts remaining. No model is
consulted. That is a boundary claim, so it is tested rather than asserted —
`tests/architecture.test.ts` walks the import graph from the replay engine and fails if any
model SDK is reachable.

**The surface** is the seam. `SurfaceDriver` perceives and acts; it does not interpret the
artifact. A second architecture test asserts only `src/surface/web/` imports a browser library.
Conditions are evaluated above the seam, so a desktop driver needs no condition logic.

## 2. Artifact schema

Zod, one JSON file per capability — diffable in a pull request, which is what makes these
reviewable at all. A capability carries a typed signature with a `pii` tag per field,
preconditions, ordered steps, exception rules, and a success checkpoint plus an answer
template. Per step: an **ordered locator ladder** (`role_name` → `label` → `nearby_text` →
`table_cell` → `css`), each rung with a `rationale`, and a `baselineRung` recorded at learning
time.

Three decisions did real work.

**`baselineRung`.** Drift is measured against the rung that resolved when the flow was
recorded, not against rung 1. ParaBank's login fields carry `role_name` and `label` rungs that
resolve to zero elements and always will; "deeper than rung 1 means drift" would fire on every
run forever, and an alert that always fires gets muted. Three-valued, so a vendor finally adding
a `<label>` reports `improved` and the baseline can be tightened.

**`effect` separate from `risk`.** `effect` answers "safe to retry"; `risk` answers "needs a
signature". A click that may already have committed is never retried even with attempts
remaining, and `maxAttempts > 1` on a non-retry-safe step is a lint error.

**Structural lint the type system cannot express.** A mutating step with no postcondition, a
declared output nothing extracts, a `recoverable` exception with no recovery plan, a
`baselineRung` past the end of its own ladder, `${inputs.x}` naming an undeclared input — all
rejected at parse time. The compiler round-trips its own output through this, so a compiler bug
surfaces at compile time rather than three screens into a replay. No application-specific
literal appears in the schema; a test rebuilds an artifact as a different vendor's product to
keep that honest.

## 3. Determinism & error handling

Determinism here means the **decision path** is fixed: same steps, same rungs, no model, nothing
sampled. It does not mean the same output. Two of these capabilities move money, so the second
transfer of the same amount is a different transfer; asserting otherwise would mean testing
against an application unlike the ones this is for. Tests touching a mutating account assert the
shape of the value and its agreement with the answer sentence, never a fixed figure.

Waiting is always on a declared condition, never a sleep — a sleep is too slow on a fast run and
too short on a slow one, and turns a real failure into a flaky one.

**Ambiguity is refused, not resolved.** More than one match fails the run. Taking `.first()` is
how automation clicks the wrong row of a payments table. Conditions and actions therefore need
different primitives: "at least one row" is legitimately many matches.

Five result variants, and the fields for one are absent from the others:

| | |
|---|---|
| `success` | outputs, plus a sentence the capability states itself |
| `business_outcome` | the automation worked; the answer is negative. A code from the reviewed artifact, so callers branch on a constant, never on prose |
| `intervention_required` | a person could plausibly finish this; the session is still alive |
| `blocked` | we refused. Nothing was attempted; the remedy is review, not debugging |
| `failure` | something broke, with `safeToRetry` derived from the step's `effect` |

Which applies is chosen by **class priority** — `business_outcome` > `recoverable` >
`hard_failure` — not by first match, because on this application a validation error and an
expired session render byte-identical text.

Exception rules are never invented: a happy-path run has seen nothing of failure, so compilation
emits `exceptions: []`. `cli probe` drives a capability into a branch twice, once with inputs
that work and once with inputs that do not, and derives the rule from the difference. That is
the only place `verified: true` is set. For not-found, no text diff can see it — ParaBank shows
the same Accounts Overview whether or not the account exists, and what differs is a row that is
absent. The masked observation answers it, because the mask token records *which field* was on
screen without either state holding an account number.

## 4. Heterogeneity & multi-tenant

The seam is `SurfaceDriver`: `observe()` returns an `Observation` containing no browser types.
A Windows driver populates the same shape from UI Automation — role, name, nearby text, column
header, row label all survive the move — and nothing above changes.

The ladder is what makes a second *web* application tractable, and it already spans both cases
within one form: submit buttons resolve at rung 1 (an `<input type=submit>` takes its name from
`value`), while the text fields beside them resolve at rung 1 and 2 to **zero** elements and are
found only by their visible caption. Both are measured in `tests/surface.test.ts`.

Multi-tenant execution is out of scope per §3.7, so what follows is the design. A tenant gets an
**overlay**, not a fork: one base plus 200 overlays of eight lines, versus 200 forks of 200
lines, where a fix in the base reaches everyone. An overlay may change copy, entry path, origins
and individual locators — `overlays/summit.account_lookup_balance.json` is worked out in full.

It may **not** change risk, effect, the signature, or an exception's class. A tenant config file
that can downgrade a transfer to `safe` is a way to disable the safety model by editing config.
That is guaranteed by construction, not by a check: the overlay type has no field in which to
say it, and is strict, so a document that tries is rejected rather than silently stripped.
`tests/overlay.test.ts` also holds the overlay to the artifact it patches — a `locators` key
naming a nonexistent step, or a `copy` rewrite of a label the base never uses, is a silent
no-op, and silent no-ops are how a tenant runs the base flow while everyone believes it was
specialised.

Drift is already per-tenant: `versionRange` bounds what a capability claims, and every replay
reports the rung that answered against the baseline. A tenant upgrade that moves a control shows
as `degraded` on that tenant's runs and nowhere else.

## 5. Escalation & handoff

"The same live session, not a fresh one" rules out the obvious implementation: a second browser
has none of the session state, so the operator signs in again and is looking at a different
reality from the one the run stopped in. It also rules out a browser owned by the agent process,
because it dies with it.

So `session serve` is a separate process whose only job is holding one Chromium open; every
other command attaches over CDP and detaches. Playwright's own `launchServer` + `connect` was
tried first and is wrong here — a second process gets an isolated view where
`browser.contexts()` is empty, exactly the failure the requirement is written to catch.
`connectOverCDP` returns the running browser's existing context and page. Both behaviours were
verified with a throwaway probe before anything depended on them.

Three checks make control transfer a mechanism rather than an announcement. **Custody is
exclusive** — a second takeover is refused, as is a handback from someone who never took it.
**A handback that changed nothing is refused**, because resuming into an unchanged screen stops
at the same step and asks again. **The resume point is computed while the operator still holds
the session**, so they can disagree with it before letting go.

Resume does not restart the failed step. The person took control *because* it could not proceed;
if they cleared it themselves, replaying does it twice, and on a transfer screen twice means
twice. The resume point is read off the page — walk forward, skip any step whose postcondition
already holds, start at the first that does not, never earlier than where it stopped, since an
earlier step's postcondition is often unmet simply because the flow moved past it. A skipped
step is recorded as `skipped`, not omitted: a trace silently missing its login steps is
indistinguishable from a run that never logged in.

Custody lives in `sessions/<id>.json` — who holds it, every transfer, a digest of the screen at
each handover, the operator's note. A digest, because the first version stored the raw
fingerprint and every entry became a full copy of the page, account table included, in a file
that never passes through the masker.

## 6. Safety

**Approval is content-addressed** — SHA-256 over canonical key-sorted JSON, binding the digest
to the bytes. Any edit invalidates it, including a plausible one like raising `maxAttempts`.
Flipping `status` by hand does not pass; a formatter reordering keys does not break a valid
approval.

**Risk is derived**, as the maximum over steps. A second place to state it is a second place for
it to drift.

**Guardrails are data.** `policy.json` holds which risk classes require approval, which origins
this deployment permits on top of the artifact's own, which actions discovery may take, and
which `pii` tags are regulated. It is load-bearing: a test runs the same draft artifact under two
policy files, refused by one and successful under the other.

**Credentials are a runtime binding, never an input.** The artifact names a logical role; the
deployment resolves it per tenant. An input would land in shell history, the result contract,
the logs and the evidence. During discovery the substitution happens at the keystroke, so the
secret never enters the model's context or the trace — an injection reaching an agent holding
only `account_number` can misuse a bounded action set; one reaching an agent holding operator
credentials has full operator access.

**Masking happens at the write**, in one recorder, over the trace and log and the page
observations inside them — a caller cannot forget to redact what it never handles. The values
are masked, not the serialised JSON: `JSON.stringify` turns a newline into `\` + `n`, so
`…\n13122` has a letter immediately before the account number and a boundary-guarded pattern
correctly refuses to match. That shipped briefly, and is why `result.json` looked clean while
`success.json` did not.

Irreversible actions are classified from what the control says about itself: a transaction verb
on a button commits and escalates on failure, the same verb on a link is treated as unverified
rather than safe. It is a name heuristic that will both miss and over-trigger; it fails in the
safe direction, `--risk` overrides it, and everything compiles to draft regardless.

## 7. Cuts

**Desktop driver.** Seam real and tested, no implementation. Building one meant a second
application to make hostile, and the seam was the part in question.

**Vision / coordinate locators.** Deliberately absent. A coordinate locator is the rung that
always resolves and never means anything, and having it available makes every rung above it
optional.

**Proxy, tenant re-skin, fault injection.** §3.7 asks for the multi-tenant design, not the
plumbing, so the schema, a worked overlay and its tests are what exists. Injected faults would
have been the honest way to exercise recovery, which is currently proved only by a hand-broken
locator.

**Open-ended self-healing on failure.** Recovery is three budgeted strategies — `dismiss`,
`wait_retry`, `re_login`, the last refused outright if any earlier step committed. The moment
replay can ask a model what to do, "production consults no model" stops being true, and that
claim is worth more than the failures it would rescue.

**Rung 5 is unreachable from discovery.** The model is never offered a CSS selector, so no
learned artifact contains one; the rung is for a human editing by hand. Handing the model a DOM
excerpt when stuck is the obvious next step and was deliberately not taken, because it widens
what the model may emit.

**Capability catalog** — the stretch goal I would pick first. Artifacts already carry typed
signatures and descriptions, so a tool-calling spec is mechanical, and it closes the loop the
brief keeps pointing at.

**No queues, database, or orchestration.** §7 says that is not rewarded. Capabilities are files;
`src/artifact/store.ts` is the only seam that would change.

### What I would fix first

The outcome probe has been run against one branch of one capability. Transfer and open-account
ship with `exceptions: []` — honest, but it means insufficient funds and the funding minimum are
undetected states on the two capabilities that move money. That gap comes before anything above.

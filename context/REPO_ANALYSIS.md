# REPO_ANALYSIS.md — Competitive teardown of five peer submissions

Five public repos answering the same interface.ai take-home ([PROBLEM.md](PROBLEM.md)).
All cloned and read at source level: four on 2026-08-15, the fifth (`yash161`) on 2026-08-18.
All were pushed 2026-08-12 → 08-13.

| # | Repo | Stack | Impl. LOC | Tests | Commits | Verdict |
|---|---|---|---|---|---|---|
| 1 | `krishlodha12/hands` | TS / Node / Playwright | 3,550 src + 1,052 React UI | 12 files, ~24 cases | 1 (squashed) | **Strongest overall.** Best schema, only one with a real UI. |
| 2 | `ujjwalredd/interface-ai-computer-use` | TS / Node / Playwright | 1,204 | 22 cases, 1 file | 6 | **Strongest engineering rigor.** Best safety + evidence integrity. Fatal generality flaw. |
| 3 | `yitingzhang1113/interfaceai-...` | Python / FastAPI / Playwright | 2,156 | 21 cases | 2 | **Best judgment & communication.** Best HITL semantics. Thinnest safety. |
| 4 | `Tmwakalasya/assesmentsoln` | Python (scaffold) | **8** | 1 trivial | 4 | **Not a submission.** Aspirational report, zero implementation. |
| 5 | `yash161/computer-use-automation` | TS / Node / Playwright / Gemini | 3,098 | 19, **all unit** | 6 | **Best escalation model in the field.** Critical locator bug; ladder unexercised. |

None of the five is complete. Section 8 is where the gap is — and §7 has been corrected
since `yash161` closes two of the gaps I originally attributed to the whole field.

---

## 1. `krishlodha12/hands`

**Framing.** Pitches itself as "a compiler, not a chat wrapper." Discovery loop → trace →
compiler → `Capability` artifact → replay VM. That framing is the strongest single idea in
any of the four repos, and it maps exactly onto the brief's through-line.

### What's built
- **Target:** self-built hostile mock, "Northstar Core" (`mock/northstar.ts`, 322 lines) —
  iframes, table layouts, no test IDs, injectable failures via `?inject=session|slow|modal`.
- **Perception:** hand-rolled accessibility-tree walker with implicit-role computation and
  accessible-name resolution, executed in-page across all frames (`src/surface/web-ax.ts`,
  539 lines). Not Playwright's built-in AX snapshot — written from scratch, which is why it
  works on the non-semantic markup.
- **Discovery:** OpenAI `gpt-4o-mini`, `temperature: 0`, JSON-object response format.
- **Replay:** 434-line VM over a closed 8-verb instruction set.
- **Extras:** React + Vite operator console with live JPEG viewport streaming and React Flow
  step graph; agent-facing catalog HTTP API; tenant overlays; golden eval harness.

### The artifact schema — best of the four
`src/types/artifact.ts`, Zod, Kubernetes-flavored (`apiVersion: "cua.capability/v1"`, `kind`,
`metadata`). Load-bearing choices:

- **Ranked locator ladder as a discriminated union** — `ax` → `label` → `nearby_text` →
  `table_header` → `css`. `table_header` (find column by header text, then cell by row match)
  is a direct, correct answer to legacy table-soup UIs. No other repo has it.
- **`exceptions[]` declared *inside* the artifact**, each carrying `class:
  business_outcome | recoverable | hard_failure` and an optional `recover` action. The error
  taxonomy is *data*, versioned and reviewable alongside the flow. This is the single best
  structural decision in any of the four repos.
- **PII taxonomy on every field** — `pii: none | identifier | name | secret`.
- **`TenantOverlay` as a separate document** patching `copy` + `locators` by key, never
  cloning the flow.

### Real weaknesses
1. **The "discovery" is heavily scaffolded.** The system prompt (`src/discovery/loop.ts:33`)
   hardcodes the field names ("Member Number"/"CIF ID"), the parameter name (`memberId`), the
   success heading, the not-found outcome, and the session-dialog remedy. Then `repairTurn()`
   deterministically patches the model's output — inferring the role, extracting the ID from
   the goal via regex, filling in the target from the observation. The evidence trace is 3
   turns. **The LLM is doing very little discovering.**
2. **The exception rules are a hardcoded constant, not discovered.** `collectExceptions()`
   (`src/discovery/compiler.ts:68`) returns a fixed 3-rule array. The loop that walks the
   trace adds to a `seen` set and then *discards it* — dead code. So the beautifully-designed
   `exceptions[]` field is populated by the developer, not learned.
3. **`status` conflates two meanings.** A successful run that recovered returns
   `status: "recoverable"` rather than `ok` + a `recovered[]` list. A caller checking
   `status === "ok"` would treat a fully successful run as not-successful.
4. **Approval gate self-defeats.** The compiler sets `status: "approved"` automatically for
   any reversible capability (`compiler.ts:200`), so the draft→approved gate only ever binds
   on irreversible flows.
5. Single squashed commit — no visible development history.

### The write-up
82 lines, tight, opinionated, quotable. *"Coordinates are not reviewable and not stable. An
accessibility tree is both, and it exists on web and desktop."* Best prose of the four.

---

## 2. `ujjwalredd/interface-ai-computer-use`

**Framing.** Security-first. The stated invariant: discovery may call a model, replay may not
even *import* the SDK — and there is a test asserting exactly that.

### What's built
- **Target:** 76-line inline Node HTTP mock — iframe shell, table layout, and seeded members
  that trigger not-found, permission-denied, session-expiry, unknown-dialog, and slow-load.
- **Perception:** **OpenAI Responses API `computer` tool** — genuine screenshot + coordinate
  computer-use, model `gpt-5.6`. Coordinates are hit-tested against the live frame and
  *converted* into a semantic fingerprint + ordered locators at compile time. **Coordinates
  are then prohibited at replay.** This is the most faithful reading of "computer use" in the
  four repos, and the coordinate→semantic compile step is a genuinely good idea.
- **Replay:** 491-line state-transition executor.

### Distinctive engineering
- **`modelCalls: 0` is a literal in every variant of the result union** (`contracts.ts:118`).
  The no-LLM-in-replay invariant is enforced by the *type system*.
- **Content-addressed approval.** `artifactDigest()` = SHA-256 over canonical (key-sorted)
  JSON of the unsigned artifact. Editing an approved artifact invalidates the digest and
  forces re-review. `FailureCode` includes `ARTIFACT_TAMPERED`.
- **Graph, not list.** `nodes` + `transitions` keyed on `success | not_found |
  session_expired`. Validated for duplicate IDs, unknown transition targets, and
  **unreachable nodes**.
- **Lint rule with teeth:** every `fill`/`click` node *must* declare a postcondition, or
  `validateArtifact` throws.
- **`effect` is separate from `risk`** — `observation | idempotent_write |
  reversible_mutation | irreversible_mutation` drives retry-safety; `risk` drives approval.
  Only observations and idempotent writes are retryable. A click that may already have
  committed is never blindly repeated. Correct and rare.
- **Money as `{currency: "USD", minorUnits: integer}`** — never float dollars.
- **Handoff is token-authenticated.** Ephemeral high-entropy claim + resume tokens, compared
  with `timingSafeEqual`, single-claim enforcement, 10-minute timeout, abortable.
- **Evidence is tamper-evident:** append-only JSONL with a SHA-256 hash chain, plus a manifest
  hashing every file, written `mode: 0o600`. Screenshots are masked before persistence.
  Playwright traces are labeled `trace.synthetic-only.zip` with an explicit note that traces
  retain DOM/network data and so are *not* described as redacted. That is unusually honest.

### The fatal flaw
The schema is **hardcoded to one application at the type level**:

```ts
compatibility: z.object({
  targetProfileId: z.literal("legacy-bank-v1"),
  title:           z.literal("Legacy Member Services"),
  frameName:       z.literal("workspace"),
  appVersion:      z.literal("legacy-bank/1"),
})
businessOutcomes: z.array(z.object({ code: z.literal("MEMBER_NOT_FOUND"), ... }))
```

A second app cannot be represented. A second business outcome cannot be represented. Yet
REPORT.md claims *"Compatibility identifies a vendor target profile and version rather than a
tenant"* and describes a registry of vendor artifacts plus tenant overrides. **The design
story and the code contradict each other**, and §7's "Generalization to the real environment"
is a top-five evaluation criterion. A reviewer who opens `contracts.ts` finds this in 30
seconds.

Secondary: the locator kinds (`role|label|text|attribute|css`) have no table/nearby-text
strategy, so it is weaker than repo 1 on exactly the legacy surface it targets. And the
REPORT.md prose is so compressed it is genuinely hard to read — a communication cost on a
criterion that is explicitly graded.

---

## 3. `yitingzhang1113/interfaceai-Computer-Use-Automation-System`

**Framing.** The most brief-aligned of the four. Every module docstring reads like it was
written to answer a specific paragraph of the assignment, and mostly succeeds.

### What's built
- **Target:** FastAPI + Jinja mock styled as "MERIDIAN CORE — Core Banking · Member Services,"
  with `?fail=timeout|modal|interstitial|apperror|notfound` runtime injection.
- **Perception:** accessibility tree primary, screenshots as evidence, CSS as last resort.
- **LLM:** provider-agnostic shim — Anthropic (`claude-sonnet-5`) or any OpenAI-compatible
  endpoint. Only repo of the four that doesn't hard-bind a vendor.
- **Replay:** 361-line explicit per-step state machine.

### The three best ideas in the whole field

1. **`resync` on handoff return** (`src/intervention/session_control.py:145`). On resume it
   does *not* re-check the step it paused on. It re-observes and returns **the first step
   whose checkpoint is not yet satisfied** — because the human may have advanced the state by
   one or several steps while in control. Repo 1 just resumes; repo 2 rechecks the current
   step. This is the correct semantics and nobody else has it.

2. **`Outcome.verified: bool`** (`src/capability/schema.py:46`). A business-outcome branch
   inferred by the compiler from a single happy-path run is marked `verified: false`, and is
   *promoted* to `true` only when a run actually hits that branch. This is honest epistemics
   about what one discovery run can possibly know — and it is precisely the weakness that
   repo 1 papers over with hardcoded exception rules.

3. **`TargetSpec.rationale: str`** — the artifact stores *why this locator is stable*, in
   prose, next to the locator. §3.2 literally asks for "how each target element/control is
   identified (**with your reasoning about robustness**)". Only repo to answer that clause
   literally.

Also strong: fixed classification order enforced in one place (`_classify`: business →
recoverable → hard, with the guarantee stated in the docstring); overlays keyed by
`(vendor, product, version)` **not by institution**, with a hard refusal to apply an overlay
across products; and an unusually honest definition of determinism —

> *"against a live app you cannot be bit-for-bit identical… What is actually delivered is a
> deterministic decision path (no LLM in the loop) + robust re-execution."*

### Best evidence coverage
Seven scenario directories, each with `run.jsonl`, `result.json`, `session_state.json` and a
screenshot: `discovery`, `replay_success`, `replay_not_found`, `replay_interstitial`,
`replay_timeout`, `replay_hard_failure`, `handoff`. The handoff dir includes
`before_handoff.png` / `after_handoff.png` / `human_actions.jsonl`. This is what §6.3 asks for.

### Real weaknesses
1. **Known interstitials are a module-level constant**, `KNOWN_DIALOGS = {"System notice":
   "Dismiss", ...}` (`engine.py:100`) — not artifact-declared. Repo 1's approach is strictly
   better here: the recovery behavior should be versioned with the capability.
2. **No content-addressed approval.** `content_hash` exists in the metadata but nothing
   verifies it, and `status: draft|approved` is not enforced at replay. Repo 2's digest gate
   is real; this one is decorative.
3. **`resolver.resolve()` under-delivers on its own docstring** — it declares a `LADDER`
   constant and describes walking it, then delegates the entire walk to `adapter.resolve()`.
   The escalation semantics are real; the ladder logic lives elsewhere.
4. **Thinnest safety layer** — allowlist and redaction exist and are tested, but there is no
   token-authenticated handoff, no evidence hash chain, no file-permission hardening.
5. REPORT.md is 343 lines — well over the brief's "~1–3 pages."

---

## 4. `Tmwakalasya/assesmentsoln`

**8 lines of Python.** `src/computer_use_automation/__init__.py` (3 lines) and a test asserting
the version string.

What exists: a `pyproject.toml`, a `uv.lock`, CI workflows with pinned action SHAs, a PR
template, two ADRs, a `ROADMAP.md`, and a 60-line `REPORT.md` written entirely in the future
tense — *"The system **will be** a Python modular monolith," "Replay **will** interpret the
saved artifact…"*

The design thinking in that report is not bad. It correctly anticipates the adapter boundary,
the effect/risk split, overlay-based tenant specialization, and drift-as-a-signal. But §4 of
the brief is unambiguous: *"the discovery run has to be real… we can't assess a description of
it."* This is a project plan submitted as a project.

**Use it as a warning, not a competitor.** It is exactly the failure mode of over-investing in
scaffolding (CI, ADRs, lockfiles, PR templates) before the vertical slice exists — which the
brief explicitly does not reward.

---

## 4b. `yash161/computer-use-automation`

**Framing.** The most product-shaped of the five. Externalised policy config, an Express
operator console, a per-step escalation declaration, and two capabilities — one of which is
genuinely irreversible. Gemini 2.5 Flash for discovery.

### The best idea in the entire field: verify the handback

Every other repo treats "the operator clicked Resume" as proof the operator did the work.
This one does not:

```ts
const interventionId = await onEscalate(step.id, pErr.message, shot);
// onEscalate resolves only after the operator signals resume. The human
// may have completed this step manually — verify against the step's own
// checkpoint before continuing, rather than trusting the handback blindly.
if (step.checkpoint) {
  const cpResult = await evaluateCheckpoint(page, step.checkpoint);
  if (cpResult.passed && !cpResult.outcome) { /* continue */ }
}
return { status: "escalated", ... };   // otherwise STAY escalated
```

And there is committed evidence of **both** outcomes:

| Evidence dir | What it proves |
|---|---|
| `evidence/escalation-run/` | operator did the work → checkpoint passed → run resumed and produced `newAccountNumber: CU-733719` |
| `evidence/escalation-unverified-handback/` | operator clicked Resume **without doing the work** → checkpoint failed → run refused to continue |

That second directory is the single most impressive artifact across all five repos. It tests a
failure mode nobody else considers — an operator who hands control back having done nothing —
which is a real 2am occurrence, and the naive design silently proceeds into a wrong state.

### Also genuinely good

- **Escalation state machine with guarded transitions.** Five states, and illegal transitions
  *throw* rather than being tolerated: `operatorTakesControl()` refuses unless the state is
  `PAUSED_AWAITING_HUMAN`. Keeps a `history[]` of every transition with actor and timestamp —
  an audit trail of who held control when. Stronger than anything else in the field.
- **`isAutomationAllowed()` checked before every action**, so ceding control is enforced rather
  than promised.
- **Policy externalised to `config/policy.json`** — origins, action types, risk rules,
  irreversible patterns. §3.4 asks for a *configurable* allowlist and a JSON file is more
  literally that than a constant in code.
- **Per-step `onError: "fail" | "escalate" | "skip"`.** Escalation policy declared per step in
  the artifact rather than hardcoded in the engine. Nobody else has this.
- **Steps are a discriminated union on `action`**, so a `type` step structurally requires a
  `value` and a `read` step requires an `outputKey`. Stricter than a single step type with
  optional fields — a genuine modelling advantage.
- **`success.checkpointOfStep`** names an existing step's checkpoint instead of duplicating the
  condition, so the two cannot drift apart.
- **The discovery log is honest about being messy**: 13 `model_action` events alongside 5
  `act_error`, 1 `agent_error` and 1 `stuck`. A real run that struggled, not a tidied one.

### The critical bug

**Resolution verifies one query and then acts on a different, looser one.** `resolveLocator`
returns a *string*, which the act functions parse back:

```ts
// resolve — verified unique, name included:
page.getByRole("button", { name: "Log In" })   // count must be 1
  → returns the string `[role="button"]`       // the NAME is thrown away

// act — reconstructed from that string:
page.getByRole("button").first().click()       // ANY button, first one wins
```

So on any page with more than one button, uniqueness is checked against `role+name` and the
click lands on whichever button happens to be first in the DOM. Same for `type` and `read`.
The `bbox` and CSS paths funnel through `.first()` too, and the CSS rung never checks
uniqueness at all — `count > 0` is enough.

This is the same class of defect I hit with `nearby_text` (a locator that resolves to exactly
one element and is confidently wrong), except mine was one strategy and this is systematic
across the most-used rung. It survives because **there is not a single integration test** —
all 19 tests are unit tests over the redactor, schema and policy; nothing drives a browser.

### Other shortcomings

1. **`strategyIndex` is computed, commented as "for telemetry (drift detection)", and never
   read anywhere.** `grep` finds zero uses outside `locator.ts`. Same unfulfilled drift promise
   as the other four — dead code standing in for a mechanism.
2. **Checkpoints are optional on every step**, and an empty checkpoint returns
   `passed: observed.length === 0` — i.e. trivially true. "I clicked, therefore it worked" is
   permitted by the schema.
3. **Multiple fields on one checkpoint are OR, not AND.** `evaluateSingleCheckpoint` returns on
   the first condition that matches, so `{urlContains, textVisible}` passes if *either* holds —
   almost certainly not what an author writing two conditions intends. Only `anyOf` (also OR)
   exists, so conjunction is inexpressible. A composite like "on the overview page **and** the
   account is listed" cannot be written.
4. **No approval integrity.** Both capabilities ship `status: "approved"` with
   `reviewedBy: "yash"`, and nothing binds that to content — the field is a flippable string.
5. **`tenant` lives inside the artifact** (`tenant: z.string().nullable()`), which ties a
   recording to an institution rather than to a vendor product. No overlay concept, so
   cross-tenant reuse is neither built nor designed.
6. **No compatibility or version range**, so replay cannot refuse to run against a wrong app
   version. Capability version is an integer, losing the minor/patch distinction between a
   structural change and a locator tweak.
7. **No `effect` separate from `risk`**, so retry-safety and approval-need are the same axis.
8. **The mock was authored with 11 `aria-label` attributes.** Rung 1 therefore wins on
   essentially every control, so rungs 2–4 are never exercised and the `bbox` rung could not
   fire even in principle. The clearest instance in the field of a target shaped to suit the
   automation.
9. **The irreversible capability was hand-written, not discovered** —
   `open-sub-account.v1.json` carries `recordedBy: "manual:yash"`. The impressive escalation
   demo runs on a hand-authored artifact; discovery produced only the read-only lookup. Honest
   provenance, but it means the discovery loop was never exercised on the hard flow.
10. **Committed evidence leaks the author's local paths** —
    `/Users/yashshah/Desktop/⚙️  Projects/interface/evidence/...` appears in every result file.
11. `getByText(..., { exact: false })` throughout, so `textVisible: "100"` matches `"1100.00"`.

### The write-up
207 lines, well within the brief's page budget, and clear. Notably honest about the mock.

---

## 5. Cross-cutting comparison

### Artifact schema

| Dimension | hands | ujjwalredd | yitingzhang |
|---|---|---|---|
| Format | Zod / JSON, k8s-style | Zod / JSON Schema 2020-12 | Pydantic / JSON |
| Structure | ordered list | **graph + transitions** | list + per-step outcome branches |
| Locator ladder | **ax→label→nearby→table_header→css** | role→label→text→attribute→css | accessibility→text→structural→css→visual |
| Locator rationale stored | no | no | **yes (`rationale`)** |
| Error taxonomy location | **in artifact (`exceptions[]`)** | in artifact (`businessOutcomes[]`, hardcoded code) | in artifact (`Step.outcomes`) + module constant |
| Outcome confidence | no | no | **yes (`verified`)** |
| Typed I/O | Zod record + `pii` tag | **strict JSON Schema, nested, money as minorUnits** | Pydantic + `sensitive` flag |
| Versioning | `apiVersion` + semver + status | schema ver + capability semver + **SHA-256 digest** | schema ver + semver + unenforced hash |
| Multi-tenant | overlay doc (copy + locators) | *impossible* — `z.literal` per app | overlay keyed `(vendor, product, version)` |

### Error taxonomy & result contract

All three implement the required three-way split, and all three get "member not found" right.
Differences that matter:

- **hands** — 5 statuses (`ok / business_outcome / recoverable / blocked / failed`). Scans
  declared exceptions **before and after every step**, plus at preconditions and at the
  success checkpoint. Most thorough detection sweep. But conflates "succeeded after recovery"
  with `recoverable`.
- **ujjwalredd** — 5-variant discriminated union with a **13-value `FailureCode`** and a
  `safeToRetry` boolean on failures. Separates `intervention_required` as its own status,
  which is arguably more correct than folding it into `blocked`. Retry safety derived from
  `effect`, not guessed.
- **yitingzhang** — 3-variant union (`Success | BusinessOutcome | Failure`), simplest, with the
  classification *order* explicitly guaranteed in one function. Recovery is not surfaced in
  the result at all — the timeout evidence returns plain `success` with no record that a retry
  happened.

**Nobody separates "recovered but succeeded" cleanly.** hands overloads status, yitingzhang
drops the information, ujjwalredd carries `recoveries[]` on success — which is the right
answer, and it's the least visible of the three.

### Human-in-the-loop

| | hands | ujjwalredd | yitingzhang | **yash161** |
|---|---|---|---|---|
| Control states | `agent / paused / human` | 6-state machine | `AGENT / REPLAY / HUMAN` + 6 statuses | 5-state, **illegal transitions throw** |
| Enforcement | `assertAgent()` throws | state machine + server broker | persisted `session_state.json` | `isAutomationAllowed()` before every action |
| Same live session | yes | yes (context/page/iframe/cookies) | yes (headed) | yes (Express console over same page) |
| Auth on control transfer | none | **ephemeral tokens + `timingSafeEqual`** | none (file signal) | none |
| Human actions captured | init-script click listener | metadata-only click/change/submit/nav | before/after diff + action log | **transition history with actor + timestamp** |
| Resume semantics | resume in place | recheck current postcondition | **`resync` → first unmet checkpoint** | **verify the step's checkpoint or stay escalated** |
| Empty-handback guard | no | no | no | **yes, with evidence of both outcomes** |
| Operator surface | **React console w/ live viewport** | localhost CLI + headed window | minimal FastAPI page | Express console |

The ideal is a composite: **yash161's verified handback and transition history + yitingzhang's
resync + ujjwalredd's token auth + hands' console.** `yash161`'s guard and `yitingzhang`'s resync
are complementary rather than competing — verify that *this* step is now satisfied, and if the
human went further, resume at the first step that is not.

### Safety

- **Allowlist:** all three enforce origin + action allowlists. ujjwalredd goes furthest —
  route+method allowlist, subresource/iframe interception, popups/service-workers/downloads
  blocked, WebSocket connections closed with code 1008.
- **Risky actions:** hands = regex risk classifier + draft/approved gate. ujjwalredd = `effect`
  enum + broker + digest-bound approval. yitingzhang = `risk: safe|risky` + unattended block.
- **Redaction:** all three redact before persistence. hands adds `fingerprint()` so an artifact
  can record "a member ID was used here" without storing it. yitingzhang redacts *in the LLM
  trajectory itself* (`[REDACTED_PARAM]` appears in the committed trace).
- **Secrets hygiene:** all four clean. No `.env` tracked anywhere.

### Tests
All three real repos have tests that read as specifications, not coverage padding. Standouts:
- `"the replay engine has no OpenAI import or model fallback"` (ujjwalredd) — structurally
  proves the core invariant.
- `"resync resumes from first unmet checkpoint not a blind retry"` (yitingzhang).
- `"exists and refuses to run — driver is the extension point, not a fake"` (hands, on the
  desktop stub) — an honest test for a deliberate mock.

---

## 6. What the field converged on — treat as table stakes

Every serious submission independently arrived at these. Shipping without them reads as a gap,
not a differentiator:

1. A **self-built hostile mock app** with runtime failure injection via query param. Nobody
   used a public demo site.
2. **Accessibility role + name as the primary locator**, CSS explicitly last-resort.
3. A **closed action vocabulary** the LLM emits — never raw Playwright.
4. **Discovery → compile → artifact → replay** as distinct phases, with the model touching
   only the first.
5. **Discriminated-union result type** with business outcome as a first-class success-ish
   variant.
6. **Per-step checkpoints/postconditions**, and waiting on a condition rather than `sleep`.
7. **Explicit control-owner state** persisted somewhere, with the human on the *same* browser.
8. **Redaction before persistence** + a `draft → approved` status field.
9. **A tenant overlay concept** that patches a base artifact rather than forking it.

---

## 7. Where they are weak — the actual opportunity

*Revised 2026-08-18 after the fifth repo. `yash161` closes the irreversible-flow gap and
sets the bar on escalation, so two claims below are narrower than they were.*

1. **Discovery is theatre.** All three heavily constrain the model — hands hardcodes field
   names in the prompt and then repairs the output; every successful discovery evidence trace
   in all three repos is **2–4 steps long**. Nobody demonstrates the LLM handling a genuinely
   multi-screen flow (search → detail → action → confirm) that the brief names as the target
   difficulty.

2. **The error taxonomy is authored, not learned.** hands hardcodes three rules in the
   compiler. yitingzhang uses a module constant for interstitials. ujjwalredd `z.literal`s the
   only possible outcome code. Nobody *discovers* an exception branch. **yitingzhang's
   `verified: false` flag is the only honest acknowledgment of this in the field** — and it's
   a flag, not a mechanism.

3. **Cross-tenant reuse is asserted, not demonstrated.** hands has one overlay file and
   `--tenant summit`, which is the closest anyone gets. ujjwalredd's schema makes it
   type-impossible while the report claims otherwise. Nobody runs one artifact against two
   visibly different variants of the same vendor product and shows the result. That is
   stretch goal #5 and it directly serves a top-five evaluation criterion.

4. **Drift detection is a paragraph in every report and code in none.** All three describe
   "ladder downgrade is a drift signal." None of them emits, stores, or acts on that signal —
   even though the resolution method is already in hand at runtime in all three.

5. **Recovery is invisible in the result contract** (see §5 above).

6. **Only one of the five handles an irreversible flow end to end** — corrected after reading
   `yash161`, who does. hands has `member.open_sub_account` and an approval command but shows
   only lookups in evidence; ujjwalredd and yitingzhang are read-only throughout. `yash161`
   escalates for operator approval on the confirm click, verifies the handback, and produces
   `newAccountNumber: CU-733719`. Caveat: that artifact was hand-written
   (`recordedBy: "manual:yash"`), so the discovery loop never drove the hard flow.

7. **Nobody exercises their own locator ladder.** This is the deepest shared weakness and it
   follows from all five building their own target. `yash161` is the clearest case — 11
   `aria-label` attributes in their mock, so rung 1 wins everywhere and the lower rungs,
   including a coordinate `bbox` rung, can never fire. A ladder whose fallbacks are never
   reached is untested code presented as a robustness strategy.

---

## 8. Recommendations for our build

**Adopt from `yash161` (the fifth repo sets the bar on escalation):**
- **Verify the handback.** After an operator signals resume, re-evaluate the step's checkpoint
  and stay escalated if it does not hold. Ship evidence of both outcomes, including the
  operator-did-nothing case. This is the strongest single idea in the field.
- **Guarded state transitions that throw**, plus a `history[]` of every transition with actor
  and timestamp — an audit trail of who held control when.
- **Policy externalised to a JSON config**, since §3.4 asks for a *configurable* allowlist.
- **Per-step `onError: fail | escalate | skip`**, so escalation policy is declared in the
  artifact rather than hardcoded in the engine.
- **Steps as a discriminated union on `action`**, so a `type` step structurally requires a value
  instead of relying on lint.
- **`success.checkpointOfStep`** — name an existing step's checkpoint rather than duplicating
  the condition, so the two cannot drift apart.

**Adopt (proven by the field, cheap to match):**
- hands' artifact shape — `apiVersion`/`kind`/`metadata`/`signature`/`steps`/`exceptions`/
  `success` — with the **locator ladder as a discriminated union including `table_header`**.
- Error taxonomy as **versioned data inside the artifact**, not code.
- ujjwalredd's **`effect` vs `risk` split** driving retry-safety, and **money as minor units**.
- ujjwalredd's **content-addressed approval digest** — ~15 lines, and it makes `approved` mean
  something.
- yitingzhang's **`resync` on handoff return** and **`TargetSpec.rationale`**.
- A test asserting the replay path cannot import the model SDK.

**Beat them on (their shared blind spots):**
1. **A genuinely multi-screen discovery run** — search → detail → action → confirmation, 8+
   real model turns, with a thin prompt that does *not* name the fields. This is the heart of
   the project and the whole field under-delivers on it.
2. **Emit and act on the drift signal.** Record which ladder rung matched per step per run;
   surface "step `s2` resolved at rung 3 of 5" in the result. Three lines of plumbing that no
   one has, answering a paragraph everyone wrote.
3. **Run one artifact against two variants** of the same mock (different labels, same flow)
   with an overlay. Converts the §3.7 essay into a demo.
4. **Report recovery honestly** — `status: "ok"` plus `recoveries: [{step, reason, attempt}]`.
   Never overload the status field.
5. **Demonstrate the irreversible path** — a confirmation-screen flow that is blocked while
   `draft`, gated on approval, and shown both ways in `/evidence/`.

**Avoid:**
- `z.literal`-ing anything app-specific into the schema (ujjwalredd's fatal flaw).
- A React operator console before the core is done — hands spent 1,052 lines there. It demos
  beautifully, but §7 ranks "System design" and "Robustness" above it, and repo 4 shows where
  scaffolding-first ends up.
- A 343-line REPORT.md. The brief says 1–3 pages and says reviewers read many side by side.

---

## 9. Questions before I go further

1. **Do you want the goal to be the multi-screen one** (search → detail → open sub-account →
   confirmation) rather than the simpler balance lookup? It's the field's biggest gap and it
   exercises the risky-action model — but it's meaningfully more work on both mock and prompt.
2. **How hard do you want to go on the "thin prompt" claim?** Committing to a system prompt
   that doesn't name the app's fields makes the discovery run genuinely impressive and
   genuinely more likely to need several attempts to land.
3. Anything in these four you want kept or explicitly rejected that I haven't flagged?

The four Section 10 decisions in [PROBLEM.md](PROBLEM.md) — target app, language, LLM
provider, time budget — are still open and still blocking.

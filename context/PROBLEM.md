# PROBLEM.md — Working brief

Internal working document. Distills the interface.ai take-home ("Computer-Use Automation
System") into what we build, what we skip, and what gets graded. Not a deliverable — the
graded docs are `/README.md` and `/REPORT.md`.

Section numbers below (§3.1, §7, …) refer to the original assignment PDF so every claim is
traceable. Anything that is my judgment rather than the brief is marked **[my read]**.

---

## 1. The system in one paragraph

Banks and credit unions run back-office apps with no API. An LLM ("computer use") drives
such an app's UI once to accomplish a natural-language goal. That successful run is recorded
as a **typed, versioned artifact** — a reusable *capability* with a declared input/output
contract. From then on, an AI agent invokes the capability by name with typed args and the
system **replays it deterministically, with no LLM in the decision loop**, returning structured
results and escalating to a human when it cannot safely proceed.

The through-line the brief states explicitly (§2):

> **The model discovers. The artifact becomes a reusable capability. Deterministic replay is
> how the AI agent invokes it in production.**

Three environment properties shape every design decision (§1):

1. **Stable UIs, real runtime errors.** Enterprise apps change slowly — that is what makes
   record-once/replay-many viable. The hard part is *not* UI drift. It is validation errors,
   "record not found", permission denials, unexpected dialogs, session timeout, transient
   slowness, app errors. Happy-path-only is explicitly called "not useful in production."
2. **Heterogeneous, often legacy surfaces.** Modern web, legacy server-rendered web
   (framesets, nested tables, non-semantic markup, no test IDs), or native desktop. No clean
   DOM, no stable selectors, no API.
3. **Multi-tenant at scale.** Hundreds of tenants × ~20 apps. Many tenants run the *same
   vendor product*, configured/branded/versioned differently.

---

## 2. MUST BUILD — the six core requirements (§3)

All six must be present. §5 is explicit: **"Prefer a thin-but-real version of every core
requirement over a polished subset."** A missing capability scores worse than a shallow one.

### 2.1 Goal-driven agent loop (§3.1)
- Input: a natural-language **goal** + a **target** (app / URL / entry point).
- LLM-driven **observe → decide → act** loop against a live surface.
- Stopping conditions: goal met, max steps, timeout, dead-end.
- Must genuinely interact with a real UI: click, type, navigate, read state.
- Mechanism is our call (DOM, accessibility tree, screenshot+coordinates, OS automation).
- Explicit steer: **"Bias toward an approach that would still work when the surface has *no*
  clean DOM."**

### 2.2 Structured artifact (§3.2) — **the focal point of the evaluation**
Brief: *"Design the schema deliberately; it's a focal point of the evaluation."* Must express
at minimum:
- ordered steps / actions,
- **how each target element/control is identified**, with our reasoning about robustness,
- **typed input parameters** (what the calling agent supplies, e.g. a member ID),
- **typed outputs** and their shape (what the agent gets back),
- a **checkpoint / success condition**.

Plus: **versioned** and **reviewable** — a human reviewer *and* a calling agent must be able
to tell what the capability does, what it needs, what it returns. Must be **decoupled from
the raw model transcript** (§2.3).

### 2.3 Deterministic replay (§3.3) — the production path
- Given artifact + input params, replay with **no LLM in the decision loop**.
- Stable element targeting, verify the checkpoint, return declared outputs.
- **Explicit three-way error taxonomy** in the result contract:

| Class | Meaning | Example |
|---|---|---|
| **Expected business outcome** | A legitimate answer the caller needs. Not a crash. | "no such member" |
| **Recoverable condition** | Handle and continue. | dismiss a known interstitial, wait/retry a transient load |
| **Hard failure** | Stop, surface a clear debuggable error. | app error, unrecoverable state |

- Failure reports must say **what step, what was expected, what was observed**.
- The glossary flags conflating outcome-vs-failure as **"the most common design mistake
  here."** This is the single highest-leverage thing to get right.

### 2.4 Safety & policy guardrails (§3.4)
- Explicit, **configurable allowlist** — permitted domains/routes *and* permitted action
  types. The agent must not act outside it.
- Distinguish **safe/reversible** from **risky/irreversible** actions; handle the risky class
  conservatively (block / require confirmation / flag — our call, must be justified).
- **Never persist secrets or raw sensitive data** (credentials, tokens, full PII) into
  artifacts or logs. Redact.

### 2.5 Evidence / observability (§3.5)
- Structured log of what the agent did **and why**.
- At least one richer signal **on failure** — screenshot, DOM snapshot, or trace.

### 2.6 Human-in-the-loop escalation & handoff (§3.6)
- **Detect and route**: identify stuck/blocked state, raise an intervention request carrying
  which capability/goal, current step, current state or screenshot, and **why it stopped**.
- **Take control of the live session**: the human operates **the same live session the
  automation was using — not a fresh one** — then hands control back so the run resumes.
- Preserve context and evidence across the handoff; **record what the human did**.
- Design the seam: automation must **pause, cede control, resume** on the same session, and
  there must be a way to know **who is (or should be) in control**.

**[my read]** The "same live session, not a fresh one" clause is a deliberate filter. Spawning
a second browser for the human is the obvious shortcut and it is what they are testing for. A
credible answer needs a browser whose lifetime is independent of the agent process plus an
explicit control-owner state.

---

## 3. DESIGN-ONLY — write up, do not build (§3.7)

Brief: *"We don't expect you to implement multi-tenant or desktop support. We **do** expect
the core abstractions not to paint you into a corner."*

Two questions to answer in `REPORT.md`:
1. **Surface abstraction** — how the artifact schema and replay engine extend from our chosen
   surface to a legacy web app and/or a desktop app. *What is the seam between "how we
   perceive/act on a surface" and "the recorded flow"?*
2. **Multi-tenant reuse** — how to represent an artifact so it is reused (or safely
   specialized/overridden) across tenants running the same vendor app, rather than
   re-recorded per tenant. How per-tenant/version drift is detected and managed.

---

## 4. OUT OF SCOPE — stated by the brief

| Thing | Why it's out |
|---|---|
| API-based integration | §1: "when a system exposes an API we integrate through the API — that's always the preferred path and is **out of scope here**." |
| A real bank system | §4: "We are **not** giving you access to a real bank system, and you should not try to obtain one." |
| Full real-time co-browsing operator console | §3.6 scope note: out of scope. Mock the operator UI; make the *handoff mechanism* and *control-transfer model* real. |
| Actually implementing multi-tenant support | §3.7 — design story only. |
| Actually implementing a desktop surface | §3.7 / §4 — a documented clean seam is fine. |
| Scaling infrastructure (queues, clusters, multi-tenant plumbing) | §7: explicitly **not rewarded**. "Prematurely building that infrastructure is not [valuable]." |
| Feature breadth, framework name-dropping | §7: explicitly not rewarded. |
| Real credentials, real PII, ToS-violating automation | §4 / §9. |
| A polished product | Header: "a focused effort, not a polished product." |

**Anything mocked must be intentional, documented, and sit at a real seam** (§4, §5).

---

## 5. NON-NEGOTIABLE

§4: *"One thing that isn't your call: the discovery run has to be real."*

> At least one genuine LLM-driven run against a live surface, with the evidence in
> `/evidence/` to show it happened. "That's the heart of the project and we can't assess a
> description of it."

Requires our own model API access. Everything else may be stubbed at a clean seam.

---

## 6. NICE TO HAVE — stretch goals (§8)

*"Only if you have time and a solid core. Pick **at most one or two** — depth over breadth."*

1. **Agent-facing capability interface** — catalog of saved artifacts as callable capabilities
   (tool/function-calling surface or API endpoint), discoverable and invocable by name with
   typed args; show one being invoked.
2. **Code generation** — emit a runnable test / page object / automation snippet from an
   artifact.
3. **Confidence & approval** — score artifacts by replay reliability; gate unattended replay
   on `draft → approved`.
4. **Assisted fallback** — on replay failure, a *bounded, policy-checked* single-step LLM
   recovery (never open-ended), recorded as evidence.
5. **Canonicalization / cross-tenant reuse** — normalize routes and values into parameterized
   patterns (`/item/12345` → `/item/:id`); and/or apply one artifact recorded on a "base" app
   to a second, slightly different variant with per-variant overrides.
6. **Multi-run stability** — replay N times, report a stability/flakiness signal.

**[my read] Ranked by signal-per-hour for this specific rubric:**
- **#1 (capability catalog)** — highest. It closes the loop the brief keeps repeating ("a
  capability an AI agent can call"). Small: a registry + a JSON-schema tool spec generated
  from the artifact + one invocation. Directly serves the top rubric line (System design).
- **#5 (cross-tenant reuse)** — second. It converts the §3.7 *design* answer into a *demo*,
  which is the section most submissions will only hand-wave. Cost: one variant of the mock app
  plus an override layer.
- **#4 (assisted fallback)** — attractive but risky; a badly-bounded version actively
  undermines the "no LLM in the decision loop" claim. Only with a hard policy gate.
- **#3, #6** — cheap but low signal. **#2** — lowest; it's a nicety, not a load-bearing idea.

Do **at most two**, only after all six core requirements are real.

---

## 7. DELIVERABLES — exact paths required (§6)

> *"Please use these exact paths and headings — we read a lot of submissions side by side."*

**1. Source code**, public git repo.

**2. `/README.md`** covering:
- setup and how to run it, including any keys/config needed, **and how to run without live
  services if applicable**,
- a **demo path**: the exact command(s) to run the agent on a goal, then replay the resulting
  artifact.

**3. `/REPORT.md`**, ~1–3 pages, using these **seven headings verbatim**:
1. Architecture
2. Artifact schema
3. Determinism & error handling
4. Heterogeneity & multi-tenant
5. Escalation & handoff
6. Safety
7. Cuts

**4. `/evidence/`** — a saved example artifact, logs from a **discovery** run and a **replay**
run, and *ideally* **one replay that hits an error or exceptional state** (bad input,
not-found, or injected failure) showing detection and reporting. Screen recording optional.

**5. Submission** (§11) — push to a **public** GitHub repo, email the link to
`assignments@interface.ai` from the address applied with (darsh@band24.com), **repo URL on its
own line, no zip.**

---

## 8. EVALUATION CRITERIA — in their stated order (§7)

> *"We'll weigh these roughly in this order."*

1. **System design** — clear boundaries, sensible data models, good trade-offs, appropriate
   simplicity. *"The artifact schema and replay contract are central."*
2. **Correctness of the core loop** — agent actually completes a real goal; artifact replays
   deterministically and verifies success.
3. **Robustness & error handling** — detection/response to runtime errors; clean separation of
   business outcomes / recoverable / hard failures; sound locator, wait, and checkpoint
   strategy.
4. **Human-in-the-loop escalation** — real mechanism, *"not just a TODO."*
5. **Generalization to the real environment** — credible design story for heterogeneous
   surfaces and cross-tenant reuse without brittle assumptions or per-tenant rebuilds.
6. **Safety & data handling** — allowlist, risky/irreversible actions, redaction.
7. **Code quality** — readable, *"reasonably typed and tested where it counts,"* easy to run.
8. **Communication** — write-up makes reasoning, trade-offs, and cut lines clear.

§5 states the meta-criterion plainly: implementation throughput is not the bottleneck, so
*"the real test is **judgment and integration**: the quality of your artifact schema, your
locator/control-robustness strategy, your error taxonomy, your control-transfer model, and how
coherently the pieces fit together."*

---

## 9. **[my read]** What the reviewer for an SWE II role actually wants to see

This section is inference, not brief text. It is how I would prioritize effort.

**The reviewer's likely mental model.** They read many of these side by side. Most will be
strong on §3.1 (agent loop — the fun part, and the part AI tooling produces fastest) and thin
on §3.3, §3.6, §7. Differentiation therefore lives almost entirely in the unglamorous half.
An SWE II hire is being assessed on *judgment under ambiguity* — §1 says outright: *"Part of
what we're assessing is the judgment you apply when a problem is open-ended."*

**Priority order for our effort — highest signal first:**

1. **The artifact schema.** Named "a focal point" (§3.2) and "central" (§7). It is the one
   artifact a reviewer can evaluate in two minutes without running anything. It must read as
   a *contract* — name, version, params with types, outputs with types, checkpoint — not a
   step list with a version field bolted on.

2. **The error taxonomy, made visible in the result type.** The glossary pre-announces the
   common failure. A result union that makes `success | business_outcome | failure`
   structurally distinct — where "member not found" simply *cannot* be represented as an
   exception — is a strong, cheap signal. Prove it with the failing-replay evidence run they
   ask for (§6.4).

3. **The locator strategy, written down.** §3.2 asks for *"reasoning about robustness"* and
   §3.1 says bias for no-clean-DOM. A recorded **ordered locator ladder** with fallbacks
   (accessible role+name → anchored text → structural path → coordinates), plus which rung
   actually matched at replay time, answers §3.1, §3.2, §3.3 and half of §3.7 at once. High
   leverage.

4. **The control-transfer model.** §7 calls out *"not just a TODO."* Needs an explicit
   control-owner state and a session whose lifetime is independent of the agent process.
   A bare CLI operator surface is fine; the *mechanism* is what is graded.

5. **`REPORT.md`, especially §4 Heterogeneity and §7 Cuts.** Cheap to write, heavily weighted,
   and the section most submissions will fumble. §5: *"Say what you cut and why, and what
   you'd build next."* An honest, specific cut list reads as seniority. A silent omission
   reads as an oversight.

6. **A deliberately hostile target app.** §4 offers this as an option; taking it signals we
   read §1 rather than skimmed it. It also gives us control over injected failures for the
   evidence run, and avoids ToS/rate-limit risk from a public site.

**Anti-patterns to avoid** (each is something the brief warns against):
- A polished agent loop with escalation stubbed as a TODO. Violates §5's "cut depth, not
  whole capabilities."
- Queues, workers, Docker orchestration, a tenant DB. §7: explicitly not rewarded.
- An artifact that is a serialized model transcript. §2.3 requires decoupling from it.
- `page.click("#submit")`-style selectors. Contradicts the stated environment.
- Prose defending a simplification instead of the simplification being obviously right.
- Exceptions for business outcomes. The named "most common design mistake."

**The final check before submitting:** can we walk the single thread end to end —
*goal → real LLM run → saved artifact → deterministic replay with params, outputs and error
handling → human takes over the live session → evidence for both runs* — and defend every
decision on it? §9: *"you own everything you submit and must be able to explain and defend
any part of it in detail."*

---

## 10. The bar — what "outperforms the field" means here

Grounded in [REPO_ANALYSIS.md](REPO_ANALYSIS.md): four peer submissions read at source level.
Three are serious (1.2k–3.5k LOC); one is an 8-line scaffold. This section is the delta
between "a good submission" and "the best one in the pile."

### 10.1 Table stakes — present in every serious submission

Shipping without these reads as a gap, not a differentiator. Non-negotiable floor:

1. Self-built hostile mock app with runtime failure injection by query param.
2. Accessibility role + name as the primary locator; CSS explicitly last-resort.
3. A closed action vocabulary the LLM emits — never raw Playwright.
4. Discovery → compile → artifact → replay as distinct phases; the model touches only the first.
5. Discriminated-union result type with business outcome as a first-class variant.
6. Per-step checkpoints/postconditions; wait on a condition, never `sleep`.
7. Explicit control-owner state, persisted, human on the **same** browser session.
8. Redaction before persistence; `draft → approved` status on the artifact.
9. A tenant overlay concept that patches a base artifact rather than forking it.
10. Tests that read as specifications, including one asserting replay cannot call the model.

### 10.2 Adopt — best ideas in the field, each cheap to match

| Idea | Source | Why |
|---|---|---|
| Locator ladder as a discriminated union, **including a `table_header` strategy** | hands | The only direct answer to legacy table-soup UIs in the field |
| Error taxonomy as **versioned data inside the artifact**, not code | hands | Makes the taxonomy reviewable and diffable with the flow |
| `fingerprint()` — record *that* an ID was used without storing it | hands | Strong redaction signal, ~10 lines |
| **`effect` separate from `risk`** driving retry-safety | ujjwalredd | A click that may have committed is never blindly retried |
| Money as `{currency, minorUnits}` — never float dollars | ujjwalredd | Correct instinct for regulated financial data |
| **Content-addressed approval digest** (SHA-256 over canonical JSON) | ujjwalredd | ~15 lines, and it makes `approved` actually mean something |
| **`resync` on handoff return** — resume at first *unmet* checkpoint | yitingzhang | Correct semantics; the human may have advanced state |
| **`rationale` stored on each locator** | yitingzhang | Literally answers §3.2's "with your reasoning about robustness" |
| `verified: bool` on an outcome branch | yitingzhang | Honest about what one happy-path run can know |

### 10.3 Win on — where the entire field is weak

These are the differentiators. Each one is a paragraph in someone's report and code in nobody's.

1. **A genuinely multi-screen discovery run.** Every successful discovery trace in the field
   is **2–4 steps**, against a prompt that names the app's fields. Target: search → detail →
   action → confirmation, with a thin prompt that does *not* hardcode field names, parameter
   names, or the success condition. This is the heart of the project (§4) and the whole field
   under-delivers on it.
2. **Emit and act on the drift signal.** All three write "a ladder downgrade signals drift."
   None records it. Carry the matched rung per step into the result and the run log.
3. **One artifact, two tenant variants.** Nobody runs a base artifact against a second,
   differently-labelled variant of the same vendor product. Converts the §3.7 essay into a demo.
4. **Report recovery honestly.** `status: "ok"` **plus** `recoveries: [{step, reason, attempt}]`.
   Never overload the status field (see 10.4).
5. **Demonstrate the irreversible path end to end.** The brief's second example goal ("open a
   new sub-account and reach the confirmation screen") is the one that makes the risky-action
   model matter. Nobody shows it. Blocked while `draft`, allowed after approval, both in
   `/evidence/`.

### 10.4 Mistakes observed — do not repeat these

| Mistake | Who | The rule for us |
|---|---|---|
| `z.literal("Legacy Member Services")` — schema hardcoded to one app at the type level, while the report claims a vendor registry | ujjwalredd | **No app-specific literal ever enters the schema.** Design story and code must agree. |
| System prompt hardcodes field names, parameter name, success heading, and the not-found remedy; then `repairTurn()` regex-patches the model's output | hands | The prompt describes the *task*, not the *app*. If we scaffold, we say so in the report. |
| `collectExceptions()` returns a hardcoded array; the loop that walks the trace to learn more adds to a `seen` set and discards it — dead code | hands | Either learn the branch or mark it `verified: false`. No dead code pretending to be a mechanism. |
| Compiler auto-sets `status: "approved"`, so the approval gate only ever binds on irreversible flows | hands | Everything compiles to `draft`. Approval is an explicit act. |
| Successful-after-recovery returns `status: "recoverable"` — a caller checking `=== "ok"` sees a successful run as unsuccessful | hands | Status says what happened to the *goal*. Recovery is a separate field. |
| Recovery information dropped entirely from the result (the timeout case returns bare `success`) | yitingzhang | Every recovery is recorded and returned. |
| `content_hash` in metadata that nothing verifies; `draft/approved` never enforced at replay | yitingzhang | No decorative fields. If it's in the schema, something checks it. |
| `resolve()` declares a `LADDER` constant, documents walking it, then delegates the whole walk elsewhere | yitingzhang | Docstrings describe what the function does, not what the module wishes it did. |
| 343-line REPORT.md against a "~1–3 pages" instruction | yitingzhang | Hard cap. Reviewers read many side by side. |
| Prose so compressed it's genuinely hard to read | ujjwalredd | Communication is a graded criterion. |
| 1,052 lines of React console before the core is finished | hands | Core first. Operator surface minimal until every §3 requirement is real. |
| CI, ADRs, lockfiles, PR templates, roadmap — and 8 lines of implementation | Tmwakalasya | **No scaffolding before the vertical slice runs end to end.** |

### 10.5 The one-line test

A reviewer should be able to open our `/evidence/` and see, in order: a real multi-screen LLM
run with a thin prompt → the artifact it compiled → that artifact replaying with different
inputs → the same artifact hitting a business outcome, a recovery, and a hard failure → a
human taking the live session and handing it back → the same artifact running against a second
tenant variant. If any link in that chain is prose instead of a file, it isn't done.

---

## 11. Open decisions — NOT YET MADE

§4 makes each of these our call, and each changes the build. To be resolved before scaffolding.

- [ ] Target application (local hostile mock / public demo site / desktop app)
- [ ] Goal complexity — simple lookup vs. the multi-screen flow in §10.3.1
- [ ] Language & runtime
- [ ] Computer-use mechanism (accessibility tree / DOM / screenshot+coordinates / hybrid)
- [ ] LLM provider, model, and whether API access is already in hand
- [ ] Architecture boundaries (single process vs. separate session service — interacts
      directly with the §3.6 same-live-session requirement)
- [ ] Artifact storage format and location
- [ ] Which one or two stretch goals, if any
- [ ] Time budget

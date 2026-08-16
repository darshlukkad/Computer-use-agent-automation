# DESIGN.md — system design

Working design doc. `REPORT.md` (the deliverable) will be the ~2-page distillation of this.
Terms are defined in [TERMINOLOGY.md](TERMINOLOGY.md); the competitive bar is
[PROBLEM.md](PROBLEM.md) §10.

**Locked decisions:** TypeScript / Node 22 · Playwright · ParaBank (vendored, unmodified) as
target · Anthropic + OpenAI both available · two capabilities (lookup, transfer) · ~3–4 days.

---

## 1. Shape of the system

```
                    ┌──────────── DISCOVERY (once, expensive, LLM) ─────────────┐
   goal + target ──▶│  loop: observe → decide → act    ──▶  trace  ──▶ compiler │──▶ artifact
                    └───────────────────────────────────────────────────────────┘   (draft)
                                        │                                              │
                                        │ escalates when stuck                    human review
                                        ▼                                              │
                              ┌──── SESSION CONTROL ────┐                              ▼
                              │ owner: agent|human|paused│                         (approved)
                              └──────────┬───────────────┘                              │
                                         │ same live browser                            │
                    ┌──────────── REPLAY (many, cheap, NO LLM) ───────────────┐         │
   artifact+inputs ─│  for each step: precondition → resolve → act → postcond │◀────────┘
                    └───────────────────────────┬─────────────────────────────┘
                                                ▼
                          success | business_outcome | intervention | blocked | failure

   everything above talks to the app only through:   SurfaceDriver
                                                      observe() act() waitFor()
                                                            │
                                  ┌─────────────────────────┴──────────────────┐
                                  │ WebDriver (built)   DesktopDriver (seam)   │
                                  └─────────────────────────┬──────────────────┘
                                                            ▼
                         [ proxy :8081 ] ───────────▶ ParaBank :8080   (third-party, unmodified)
                          tenant re-skin
                          fault injection
```

**The one seam that matters:** `SurfaceDriver`. Only `surface/web/` may import Playwright.
Artifacts never mention it. That's what makes the desktop story credible rather than aspirational.

### Repo layout

```
src/
  artifact/    schema.ts  digest.ts  overlay.ts  store.ts
  result/      types.ts
  surface/     driver.ts            ← the seam (interface only)
               web/  axtree.ts  resolve.ts  driver.ts
  policy/      allowlist.ts  risk.ts  redact.ts
  discovery/   prompt.ts  loop.ts  compile.ts
  replay/      engine.ts  conditions.ts  classify.ts
  session/     control.ts
  hitl/        intervention.ts  operator.ts
  catalog/     registry.ts  tools.ts        ← stretch goal
  evidence/    recorder.ts
  cli.ts
proxy/         server.ts  tenants.ts  faults.ts   ← test infra, never shipped
capabilities/  *.json      overlays/ *.json       evidence/      tests/
ParaBank-Mock-app/                               ← vendored third-party target
```

Single process, filesystem JSON storage, no queue, no database. §7 of the brief explicitly
does not reward scaling infrastructure.

---

## 2. The artifact schema

The graded centerpiece. Zod, serialized as JSON, one file per capability.

**Hard rule, learned from a peer failure:** no application-specific literal ever enters the
schema. `ujjwalredd` wrote `title: z.literal("Legacy Member Services")`, making a second app
type-impossible while their report claimed a vendor registry. Everything app-specific here
lives in *data*, never in the type.

```ts
Capability = {
  apiVersion: "cua.capability/v1"
  kind:       "Capability"

  metadata: {
    id:          string            // "account.lookup_balance"
    version:     semver            // struct change → minor, locator tweak → patch
    status:      "draft" | "approved" | "deprecated"
    title, description: string     // agent- and human-readable
    digest?:     sha256            // set at approval, over canonical JSON
    approval?:   { digest, approverId, approvedAt }
  }

  provenance: {                    // where this came from — evidence, not contract
    discoveryRunId, model, createdAt, runnerVersion, liveLlm: boolean
  }

  compatibility: {                 // WHICH app, not which tenant
    vendor:       string           // "parasoft"
    product:      string           // "parabank"
    versionRange: string           // ">=5.0.0 <6.0.0"
    detect?:      Condition        // how to read the running app's version
  }

  entry: { originAllowlist: string[], path: string }

  signature: {                     // the callable contract
    inputs:  Record<string, FieldSpec>
    outputs: Record<string, FieldSpec>
  }

  preconditions: Condition[]
  steps:         Step[]
  exceptions:    ExceptionRule[]
  success:       { checkpoint: Condition, extract: Extraction[] }
}

FieldSpec = {
  type:        "string" | "number" | "money" | "boolean"
  required:    boolean
  pii:         "none" | "identifier" | "name" | "secret"
  pattern?:    string              // e.g. "^[0-9]{5}$"
  description: string              // what a calling agent reads
}
```

### Step

```ts
Step = {
  id:      string                  // "s3"
  action:  "navigate"|"fill"|"click"|"select"|"read"|"wait"|"assert"
  target?: Target
  value?:  ValueExpr

  effect:  "observation" | "idempotent_write"
         | "reversible_mutation" | "irreversible_mutation"   // → may we RETRY?
  risk:    "safe" | "reversible" | "irreversible"            // → does it need APPROVAL?

  precondition?:  Condition
  postcondition?: Condition        // required on fill/click — lint enforces it
  timeoutMs: number                // default 15_000
  maxAttempts: number              // default 1; >1 only if effect is retry-safe
  extractTo?: string
}

ValueExpr = { kind: "param",  name: string }     // ${inputs.accountId}
          | { kind: "const",  value: string }    // never a secret
          | { kind: "secret", ref: string }      // env lookup at runtime, never stored
```

**`effect` and `risk` are separate on purpose.** Effect decides retry-safety: a click that may
already have committed a transfer must never be blindly repeated. Risk decides approval. They
are not the same axis and collapsing them is how you get a retry loop that transfers money twice.

### Target — the locator ladder

```ts
Target = {
  strategies: LocatorStrategy[]    // ORDERED. rung 1 first.
  rationale:  string               // why this is stable — §3.2 asks for exactly this
}

LocatorStrategy =
  | { kind: "role_name",   role, name }            // rung 1  ports to desktop
  | { kind: "label",       text }                  // rung 2  ports to desktop
  | { kind: "nearby_text", text, direction }       // rung 3  ports to desktop
  | { kind: "table_cell",  header, rowMatch? }     // rung 4  ports to desktop
  | { kind: "css",         selector }              // rung 5  WEB ONLY — drift signal
```

Rungs 1–4 describe what a human operator perceives and have direct OS-accessibility
equivalents. Rung 5 depends on developer-assigned identifiers; firing it is recorded as drift.

> On ParaBank's login form rungs 1 and 2 return **zero** elements and rung 3 is the only one
> that resolves. Measured, not assumed.

### Condition — composable, closed DSL

```ts
Condition =
  | { kind: "visible",       target }
  | { kind: "text_present",  text }
  | { kind: "text_absent",   text }
  | { kind: "url_contains",  value }
  | { kind: "count_at_least",target, n }     // "accounts table has ≥1 row"
  | { kind: "value_equals",  target, value }
  | { kind: "all", items: Condition[] }
  | { kind: "any", items: Condition[] }
```

Closed set, no expression evaluation, no code in artifacts. `all`/`any` exist because ParaBank
forces it: a validation error and an expired session render **byte-identical** text, so
discrimination needs `all: [text_present("internal error"), text_absent("Accounts Overview")]`
rather than a single string match.

### ExceptionRule

```ts
ExceptionRule = {
  id:       string
  when:     Condition
  class:    "business_outcome" | "recoverable" | "hard_failure"
  code:     string                 // "ACCOUNT_NOT_FOUND", "SESSION_EXPIRED"
  recover?: RecoveryPlan           // required iff class is "recoverable"
  verified: boolean                // true only once observed in a real run
}
```

`verified` is honest epistemics: a branch the compiler *predicted* from one happy-path run is
`false` until a run actually hits it. Borrowed from `yitingzhang`, the one peer who admitted
this problem exists.

### TenantOverlay — a patch, never a fork

```ts
TenantOverlay = {
  apiVersion: "cua.overlay/v1", kind: "TenantOverlay"
  metadata:   { id, tenant, appliesTo: { capabilityId, versionRange } }
  compatibility: { vendor, product }        // must match base or merge is refused
  entryPath?:      string
  originAllowlist?: string[]
  copy:     Record<string, string>          // "Username" → "Member Number"
  locators: Record<stepId, Target>          // full override for one step
}
```

**Overlays may change labels, paths, and locators. They may never touch `risk`, `effect`,
`signature`, or an exception's `class`.** Enforced in the merge function — otherwise tenant
config becomes a way to disable the safety model.

---

## 3. Result contract

```ts
ReplayResult =
  | { status: "success",              outputs, recoveries[], trace, evidenceDir }
  | { status: "business_outcome",     code, observed, recoveries[], trace, evidenceDir }
  | { status: "intervention_required",interventionId, reason, stepId, trace, evidenceDir }
  | { status: "blocked",              policyRule, reason, evidenceDir }
  | { status: "failure",              code, stepId, expected, observed,
                                      safeToRetry, trace, evidenceDir }
```

Five decisions worth defending:

1. **`business_outcome` is not an error.** "No such account" is an answer. The brief names
   conflating these as the most common design mistake; making it a separate variant means a
   caller *cannot* accidentally treat it as a crash.
2. **`recoveries[]` rides on `success`, not the status.** `hands` returns
   `status: "recoverable"` for a run that fully succeeded after retrying — so a caller checking
   `status === "ok"` sees a successful run as unsuccessful. Status describes what happened to
   the *goal*; recovery is separate data.
3. **`blocked` ≠ `failure`.** Blocked means *we refused* (policy, unapproved irreversible).
   Failure means we tried and it broke. Different remedies: get approval vs. debug.
4. **`safeToRetry` is derived from `effect`,** never guessed.
5. **`trace` carries the drift signal** — see below.

```ts
StepTrace = { stepId, action, resolvedRung: number|null, strategy: string,
              attempts, durationMs, outcome }
```

Recording *which rung matched* is nearly free once the ladder exists and no peer repo does it.
It's what turns "a ladder downgrade signals drift" from a sentence in a report into telemetry.

---

## 4. Replay algorithm

```
validate inputs against signature.inputs        → failure INPUT_VALIDATION
policy: origin + actions + approval gate        → blocked
load artifact (+ overlay if tenant given), verify digest if approved
verify compatibility.versionRange against the running app
navigate to entry, check preconditions

for each step:
    policy check on this action
    wait until step.precondition holds          → else classify()
    resolve target down the ladder              → record rung
         0 matches → classify()
        >1 matches → failure TARGET_AMBIGUOUS   (never .first(); never guess)
    act
    wait until step.postcondition holds         → else classify()
        retry only if effect ∈ {observation, idempotent_write} and attempts < maxAttempts

verify success.checkpoint                       → else classify()
extract declared outputs, validate against signature.outputs
return success + recoveries + trace
```

### `classify()` — the fixed-order guarantee

Evaluate **every** matching exception rule, then pick by class priority:

```
business_outcome  >  recoverable  >  hard_failure
```

Deciding by priority rather than by first-match means a legitimate business result can never be
mislabeled as a crash because of rule ordering in the file. If nothing matches, it's a hard
failure with step / expected / observed / screenshot.

### Determinism, honestly

Against a live app you cannot be bit-for-bit identical — balances move, timing varies. What is
deterministic is the **decision path**: no model chooses anything at runtime, the ladder order
is fixed, and waits are on conditions rather than durations. Checkpoints absorb the variance.
We say exactly this in REPORT.md rather than overclaiming.

---

## 5. Escalation & handoff

```ts
SessionControl {
  owner: "agent" | "human" | "paused"
  assertAgent(op)     // driver refuses to act unless owner === "agent"
  pause(intervention) // agent → paused, snapshot + context written
  takeOver()          // paused → human
  resume()            // human → agent
}
```

Persisted to `session_state.json` on every transition so "who is in control" is externally
observable, not just in-memory.

**Stuck** = no locator matched · checkpoint failed with no matching rule · unknown dialog ·
irreversible step without approval · discovery making no progress.

**Same live session** — the human drives the same Playwright page, same cookies, same
half-filled form. A headed browser plus a small CLI/HTTP operator surface. Human clicks are
captured via an init script (metadata only, never keystrokes or field values).

**Resync on return** — do *not* blindly re-run the paused step; the human may have advanced
several. Re-observe and resume from the **first step whose postcondition is not yet satisfied**.
`yitingzhang` is the only peer with this and it's the correct semantics.

---

## 6. Safety

| Control | Mechanism |
|---|---|
| Allowlist | permitted origins + permitted action kinds, checked per action, in our code — never by asking the model |
| Irreversible actions | compile to `status: "draft"`; unattended replay **blocked** until explicitly approved |
| Approval integrity | SHA-256 digest over canonical JSON; editing an approved artifact invalidates it |
| Secrets | `{kind:"secret", ref}` resolved from env at runtime, never serialized |
| Redaction | applied *before* anything is written to log, artifact, or screenshot |
| Parameterization | discovery literals become `${inputs.*}`; compile **fails** if a literal survives |
| Fingerprint | record *that* an account id was used, never the value |

**Everything compiles to `draft`.** `hands` auto-approved reversible capabilities, so their
approval gate only ever bound on irreversible flows — a gate that mostly doesn't apply isn't a
gate. Approval is always an explicit human act here.

**Stated limit:** an allowlist cannot stop a *permitted* click from doing the wrong business
thing. That's why checkpoints, declared exceptions, and HITL exist. None of this substitutes
for entitlements on the core system.

---

## 7. The two capabilities

| | `account.lookup_balance` | `account.transfer_funds` |
|---|---|---|
| Flow | login → overview → read balance for account | login → transfer → confirmation |
| Inputs | `accountId` | `fromAccount`, `toAccount`, `amount` |
| Outputs | `balance` (money), `accountId` | `confirmationText`, `amount` |
| Effect | `observation` | `irreversible_mutation` |
| Risk | `safe` | `irreversible` |
| Status | approvable | **draft — blocked until approved** |
| Business outcome | account not in list | insufficient funds |

Money is `{ currency: "USD", minorUnits: integer }`. Never float dollars.

---

## 8. Proxy (test infrastructure, never shipped)

`proxy/` sits in front of ParaBank. Two jobs, one real purpose:

- **Tenant re-skin** — rewrite `Username → Member Number`, `ParaBank → Summit Credit Union`,
  shift the entry path. That's tenant B: same vendor product, different configuration. This is
  the actual reason it exists, since we only have one app.
- **Fault injection** — delay a response, substitute an error page. A bonus; most of our error
  taxonomy comes from conditions ParaBank produces *naturally* (silent empty result table,
  internal error page, session expiry), which is stronger evidence than synthetic `?fail=` flags.

The payoff to demonstrate: **one artifact + an 8-line overlay replays green against both.**

---

## 9. Build order

Rationale: prove the schema with a working replay engine **before** any model output depends on
it. Most people build discovery first, find their schema can't express what replay needs, and
retrofit the graded centerpiece.

| # | Step | Gate |
|---|---|---|
| 1 | `artifact/schema.ts`, `result/types.ts` | types compile, digest round-trips |
| 2 | `surface/` — a11y walker + ladder | resolves ParaBank login, table, transfer form |
| 3 | `replay/` + `classify` | **hand-written** artifact replays green + hits not-found |
| 4 | `discovery/` — LLM loop + compiler | real run emits an artifact matching step 3's shape |
| 5 | `policy/`, `evidence/` | redaction tested; failure screenshots land |
| 6 | `session/`, `hitl/` | pause → human acts → resync → resume, one session |
| 7 | `proxy/` + overlay | one artifact green on both tenants |
| 8 | evidence runs, README, REPORT | full chain reproducible from a clean clone |

Steps 1–3 are the spine. Stretch (capability catalog) only after 8.

## 10. Deliberate cuts

Desktop driver (interface + a stub that refuses to run, so the seam is honest, not faked) ·
vision/coordinate driver · real co-browsing console · queues, database, multi-tenant plumbing ·
open-ended LLM self-healing on replay failure · codegen. Each documented in REPORT.md §7.
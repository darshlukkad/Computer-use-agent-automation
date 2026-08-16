# TERMINOLOGY.md

Every term this project uses, in plain language, with a concrete ParaBank example where one
helps. Terms marked **[brief]** come from the assignment's own glossary; the rest are ours.

Read §1 first — the other sections assume it.

---

## 1. The core idea (read this first)

### Computer use **[brief]**
An LLM operating a computer interface the way a person would: reading the screen or page,
then clicking and typing — rather than calling an API. We use it because the legacy bank apps
this system targets have no API at all.

### Discovery (a.k.a. the discovery run)
The **first**, expensive run. An LLM is given a goal in English ("look up account 13122 and
return its balance") and a starting URL, and it drives the real browser until the goal is met:
look at the page → decide the next action → do it → look again. Slow, costs money,
non-deterministic. We do it **once** per capability.

### Artifact (a.k.a. capability)
**The saved recipe.** A typed, versioned JSON file describing how to accomplish the task,
produced from a successful discovery run. It records:

- the ordered **steps**,
- how each control is **identified** (see *locator*),
- the **typed inputs** the caller must supply,
- the **typed outputs** the caller gets back,
- the **success condition**, and
- the known **exceptional states** and what class each one is.

Crucially it is *not* the model's transcript. The transcript is evidence; the artifact is a
clean, reviewable contract. A human should be able to read it in a code review and a calling
agent should be able to invoke it without ever seeing the conversation that produced it.

Think: a Standard Operating Procedure, not a chat log.

### Replay
**Running the artifact with the LLM switched off.** Given the artifact and
`{accountId: "13122"}`, it drives the browser through the recorded steps, verifies each
checkpoint, and returns `{balance: "$1100.00"}`. Fast, cheap, and identical every time.
This is the path a production AI agent actually triggers.

### Deterministic replay **[brief]**
Re-running a recorded flow the same way every time, with no model deciding anything. Same
inputs, same steps, same outputs.

> **An honest caveat.** Against a live application you can never be bit-for-bit identical —
> balances change, timing varies. What is genuinely deterministic is the **decision path**:
> no model chooses anything at runtime. Checkpoints absorb the data and timing variance.

### The through-line
> The model discovers → the artifact becomes a reusable capability → deterministic replay is
> how the AI agent invokes it in production.

### Compiler
The component that turns a discovery **trace** (what the model actually did) into an
**artifact**. It parameterizes literals (the `13122` the model typed becomes
`${inputs.accountId}`), builds the locator ladder for each control, and attaches checkpoints.

### Trace
The raw, ordered record of what happened during a discovery run — each observation, the
model's stated reasoning, and the action taken. Input to the compiler; kept as evidence;
never shipped as the artifact.

---

## 2. Seeing and touching the page

### DOM **[brief]**
The browser's structured representation of a page. A "clean DOM" has meaningful elements and
stable identifiers. Legacy apps usually don't — ParaBank's login form is `<div>`s and `<b>`
tags with no semantic structure at all.

### Accessibility tree **[brief]**
The parallel representation browsers and operating systems expose for screen readers, made of
**roles** (button, textbox, heading) and **accessible names**. Often more stable than raw
markup, and — importantly — it exists on desktop apps too via OS accessibility APIs. This is
our primary perception channel, because it's the one that ports beyond the browser.

### Accessible name
The label a screen reader would announce for a control. Derived from an `aria-label`, an
associated `<label>`, a `title`, or the element's own text.

> **Measured on ParaBank:** the login fields have **none of these**. The caption is a
> `<p><b>Username</b></p>` *sibling* of the input, with no association. So the field's
> accessible name is empty, and `getByRole("textbox", { name: "Username" })` finds **zero**
> elements. This is exactly why the locator ladder below exists.

### Surface
Any application the system can drive: a modern web app, a legacy web app, or a native desktop
app. Deliberately generic — "browser" is one case, not the definition.

### Surface driver (the seam)
The single interface everything else talks through — roughly `observe()`, `act()`,
`waitFor()`. Only the driver knows Playwright exists. Swapping web → desktop means writing a
new driver; **the artifact and the replay engine don't change**. This boundary is what makes
the design portable, and it's the answer to the brief's "heterogeneous surfaces" question.

### Observation
One perception snapshot: current URL, the accessibility nodes on screen, visible text, and
any open dialogs. What the model sees during discovery, and what replay checks conditions
against.

---

## 3. Finding the right control

### Locator / selector **[brief]**
How you tell automation *which* control to act on. The choice determines whether replay still
works next month.

### Test ID **[brief]**
An attribute developers add specifically so automation can find an element reliably
(`data-testid="submit"`). Legacy enterprise apps essentially never have them. ParaBank has
exactly zero.

### Locator ladder
An **ordered list of strategies** for finding one control, tried best-first. We store the
whole ladder in the artifact, not just one selector, so replay degrades gracefully instead of
failing outright.

### Rung
One entry in that ladder. Our term, not standard vocabulary — a ladder has rungs, so strategy
#1 is "rung 1". Rung 1 is the most stable, rung 5 the last resort. Replay walks *down* the
ladder until a strategy matches, so "resolved at rung 3" means the first two found nothing and
the third worked.

The ladder, top to bottom:

| Rung | Strategy | Example |
|---|---|---|
| 1 | **accessible role + name** | the button named "Log In" |
| 2 | **label association** | the input whose `<label>` says "Amount" |
| 3 | **nearby text** | the input immediately after the bold text "Username" |
| 4 | **table header** | the cell under the column headed "Balance*", in the row matching the account |
| 5 | **CSS selector** | `#accountTable` — last resort |

> On ParaBank's login form, rungs 1 and 2 both return **zero** elements and **rung 3 is the
> only one that works**. That's what makes the ladder load-bearing here rather than decorative.

### Rung downgrade / drift signal
If a step that used to resolve at rung 1 now only resolves at rung 4, the automation still
works — but the UI has probably changed underneath us. Recording *which rung matched* turns a
silent degradation into an early warning, days before anything actually breaks. Cheap to
capture, and nobody in the peer field does it.

### Why the ladder is ordered this way
Rungs 1–4 describe things a **human operator can perceive** — a control's role, its visible
label, what sits next to it, which column it's under. Those survive version changes because
they're what the vendor's own users are trained on. Rung 5 (CSS) depends on identifiers a
**developer assigned**, which churn every release and don't exist on desktop surfaces at all.
Hence: last resort, web-only, and logged as a drift signal when it fires.

### Structural locator
Finding a control by its position relative to something stable — "the input following the
text 'Username'", "the cell in the column headed 'Balance*'". Slower and uglier than an ID,
but frequently the only thing that survives on legacy markup.

---

## 4. Knowing it worked

### Checkpoint **[brief]**
A condition you assert to confirm you actually reached the state you expected, rather than
assuming the click worked. "After clicking Log In, the heading *Accounts Overview* must be
visible." Without checkpoints, a failed login silently proceeds and types a password into
whatever happens to be on screen.

### Precondition
A condition that must hold *before* a step runs. "We must be on the transfer page."

### Postcondition
A condition that must hold *after* a step runs, proving it took effect. "The amount field now
contains 25."

### Success condition
The final checkpoint for the whole capability — how replay decides the goal was actually
achieved, independent of whether the steps merely completed without throwing.

### Waiting on a condition (not sleeping)
`sleep(3000)` is both flaky and slow. We wait *until a checkpoint holds*, with a timeout.

> ParaBank's accounts table arrives via JavaScript — the raw HTML contains an empty
> `<tbody></tbody>`. Replay must wait for rows to exist, not guess a duration.

---

## 5. When things go wrong — the error taxonomy

This is the part the brief calls the most commonly botched design decision. Three categories,
and conflating them is the classic mistake.

### Business outcome **[brief]**
**A legitimate answer the caller needs — not a crash.** "No such member." "No transactions
matched." The automation worked perfectly; the answer is simply negative. It must be reported
as a *result*, never thrown as an exception.

> On ParaBank, searching transactions for an amount that doesn't exist returns an **empty
> table with headers and no message** — a silent business outcome, harder to detect than a
> friendly "not found" banner.

### Recoverable condition
Something the system can handle by itself and continue: dismiss a known interstitial dialog,
wait and retry a slow load, re-login after a session timeout. Replay handles it and carries
on — but **records that it happened**.

### Hard failure
Something the system cannot safely proceed past. It stops and reports **which step, what was
expected, and what was observed**, plus a screenshot. The caller gets a debuggable error, not
a stack trace.

### Result contract
The typed shape replay returns, in which the three classes above are structurally distinct —
so a caller physically cannot mistake "no such account" for "the browser crashed".

```
success          → outputs, plus any recoveries that occurred
business_outcome → a code like ACCOUNT_NOT_FOUND
failure          → step, expected, observed, evidence path
```

### Exception rule
A declaration *inside the artifact* that says: when this condition appears on screen, classify
it as business outcome / recoverable / hard failure — and if recoverable, here's the fix.
Storing this as versioned data (rather than hardcoded in the engine) means the taxonomy is
reviewable and diffable alongside the flow.

> **A ParaBank wrinkle worth knowing:** a validation error and an expired session render
> *byte-identical* text — "Error! An internal error has occurred and has been logged." So our
> rules cannot rely on matching banner strings alone; they need context.

### UI drift
The application's interface changing over time, breaking locators. Secondary in this
environment — enterprise apps change slowly — but the ladder plus rung-downgrade signal is
how we degrade gracefully rather than fail.

---

## 6. Bringing in a human

### Escalation
Detecting that automation is stuck or unsafe to continue, and routing the problem to a person
instead of guessing. Triggers: no locator matched, a checkpoint failed, an unknown dialog
appeared, or a risky step needs sign-off.

### Intervention request
The package handed to that person: which capability and goal, the current step, a screenshot
of the current state, what was expected, what was observed, and **why it stopped**. Enough
context to act without reading logs.

### Handoff / control transfer
Pausing automation and letting a human operate **the same live browser session** — same page,
same cookies, same half-filled form — then handing control back. Not a fresh browser. The
brief is emphatic about this, and it's the requirement most likely to be faked.

### Control owner
Explicit state recording who may act right now: `agent`, `human`, or `paused`. The driver
refuses to issue actions unless the agent owns the session. This is what makes handoff a
mechanism rather than a convention.

### Resync (resuming correctly)
On handing control back, do **not** blindly re-run the step you paused on — the human may have
already completed it, or several steps. Re-observe the page and resume from the **first step
whose checkpoint is not yet satisfied**.

---

## 7. Safety

### Allowlist
An explicit, configurable list of what the automation may do: permitted origins and routes,
and permitted action types. Anything outside it is refused. Enforced by our code, not by
asking the model nicely.

### Safe / reversible vs risky / irreversible
Reading a balance is reversible — do it a thousand times, nothing changes. **Transferring
funds is irreversible.** The two classes get different treatment: irreversible capabilities
cannot run unattended until explicitly approved.

### Effect vs risk
Related but distinct. **Effect** (`observation`, `idempotent_write`, `irreversible_mutation`)
determines whether a step is safe to *retry*. **Risk** determines whether it needs *approval*.
A click that may already have committed a transfer must never be blindly retried.

### Draft → approved
An artifact's lifecycle state. Freshly compiled artifacts are `draft`. A human reviews and
approves. Irreversible capabilities are blocked from unattended replay while `draft`.

### Content-addressed digest
A SHA-256 hash over the artifact's canonical form, stored at approval time. If anyone edits an
approved artifact, the hash no longer matches and it must be re-reviewed. Makes "approved"
mean something enforceable rather than a field anyone can flip.

### Redaction
Stripping secrets and sensitive data (credentials, tokens, account numbers, SSNs) *before*
anything is written to a log, artifact, or screenshot. This is regulated financial data.

### Parameterization
Replacing the concrete values used during discovery with typed placeholders. The `13122` the
model typed becomes `${inputs.accountId}`. Real customer data never lands in a stored artifact.

### Fingerprint
A one-way hash of a value, so an artifact can record *that* an account number was used without
storing the number itself.

---

## 8. Scale and reuse

### Tenant **[brief]**
One customer institution. Hundreds of them, many running the same vendor software configured
and branded differently.

### Vendor product
The underlying software a tenant runs. Fifty credit unions might all run "CoreBank v9" with
different logos, field labels, and versions. The flow is the same; the surface details differ.

### Tenant overlay
A small patch document applied over a base artifact to specialize it for one tenant — changed
labels, a different entry path, an extra locator. **The flow is not copied.** Fix a bug in the
base and every tenant gets the fix.

### Canonicalization
Normalizing concrete values into patterns so an artifact generalizes: `/account/13122` becomes
`/account/:id`.

### Capability catalog
A registry exposing saved artifacts as callable, typed tools that an AI agent can discover by
name and invoke with typed arguments — the production interface to all of this.

---

## 9. This project's own pieces

### Target application
The stand-in for a real bank system. Ours is **ParaBank** — a real third-party Java/JSP demo
banking app from Parasoft, vendored unmodified in `ParaBank-Mock-app/`. We chose a real app we
cannot modify over a mock we'd write ourselves, so our locator strategy has to survive a
surface we didn't design. See [ParaBank-Mock-app/VENDOR.md](../ParaBank-Mock-app/VENDOR.md).

### Proxy
A small HTTP proxy we place in front of ParaBank, doing two jobs the real app won't:
**injecting faults** (slow responses, error pages, an unexpected dialog) so we can prove the
error taxonomy works, and **re-skinning labels and branding** to simulate a second tenant
running the same vendor product. Injecting at the network edge is also the honest version —
you can't add a `?fail=timeout` parameter to a client's core banking system.

### Evidence
The artifacts of a run, written to `/evidence/`: a structured log of what happened and why,
the resulting artifact, results, and screenshots on failure. Proof the system did what we say,
and the material for debugging when it doesn't.

### Provenance
Metadata on an artifact recording where it came from: which discovery run, which model, when,
and whether a live LLM was actually used.

---

## 10. One-paragraph summary

An **LLM** drives a real **surface** (ParaBank) to accomplish a **goal** — that's
**discovery**. The **compiler** turns that run's **trace** into a typed, versioned
**artifact**: steps, **locator ladders**, typed inputs and outputs, **checkpoints**, and
declared **exception rules**. Afterwards, **replay** executes that artifact with **no model in
the loop**, returning a **result** that cleanly separates **business outcomes** from
**recoverable conditions** and **hard failures**. When it can't safely continue, it
**escalates** — handing the **same live session** to a human and **resyncing** on return.
Throughout, an **allowlist** bounds what may happen, **irreversible** actions require
**approval**, and everything sensitive is **redacted** before it's written down.

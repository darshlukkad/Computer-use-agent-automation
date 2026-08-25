# Computer-use automation

An agent that learns a business workflow by doing it once, on a real application, under a
model's direction — and then repeats it forever without one.

The output of a learning run is not a script and not a transcript. It is a **capability**: a
reviewable JSON artifact naming its typed inputs and outputs, an ordered locator ladder per
control with the reasoning behind it, a checkpoint per step, what each step does to the world,
and what its known failure modes look like. Replay executes that artifact. Nothing in the
replay path can reach a model — [an architecture test walks the import graph and fails if one
becomes reachable](tests/architecture.test.ts).

The target is [ParaBank](ParaBank-Mock-app/VENDOR.md), Parasoft's own demo bank, vendored
unmodified. A real legacy JSP application we did not write and cannot influence — which is the
only way a claim about surviving hostile markup can be anything but self-graded. Its login
fields have no `id`, no `<label>` and no accessible name, so `getByRole(name:)` and
`getByLabel` both resolve to **zero** elements. The ladder is not decoration; it is the only
thing that finds them.

```bash
./run.sh          # from a clean clone to a running console
./review.sh       # four minutes: every claim below, checked against a live run
```

- **[REPORT.md](REPORT.md)** — the design, and what was cut.
- **[evidence/](evidence/README.md)** — real runs: discovery, replay, a business outcome, a
  policy refusal, and a human taking the browser mid-run.

### Assessing this

`./review.sh` is a guided tour for someone reviewing the work. Each section states a claim,
runs the command that would falsify it, and shows the output — the boundary between replay and
the model, the locator rung that actually resolved, a missing record coming back as a business
outcome rather than an error, a policy refusal, approval surviving a formatter but not an edit,
and an account number reaching the caller while never reaching disk. It exits non-zero if any
claim fails, so it doubles as a smoke test. `--pause` stops between sections.

It needs no model API key. Only `npm start` → *Discover* does, and that is the one thing that
should.

---

## Setup

```bash
./run.sh
```

Requires Node ≥ 22.6 and Docker, and nothing else — ParaBank is built inside a container, so
no JDK or Maven touches the host. The script installs dependencies and Chromium, creates
`.env`, builds the application, starts it, waits for it to answer, and opens the console.
Every step is skipped when it is already done, so re-running costs about two seconds.

| | |
|---|---|
| `./run.sh` | set up whatever is missing, then open the console |
| `./run.sh setup` | the same, but stop once it is ready |
| `./run.sh check` | report what is and is not ready; change nothing |
| `./run.sh stop` | stop the application, keeping its data |
| `./run.sh reset` | rebuild the application's database from scratch |
| `./run.sh clean` | remove everything the script created |

First run takes a few minutes, almost all of it Maven building the WAR. Afterwards it is
seconds.

<details>
<summary>The same thing by hand</summary>

```bash
npm install
npx playwright install chromium
cp .env.example .env

cd ParaBank-Mock-app
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD":/app -v "$PWD/.m2":/var/maven/.m2 -w /app \
  -e MAVEN_CONFIG=/var/maven/.m2 \
  maven:3.9-eclipse-temurin-21 \
  mvn -q -Duser.home=/var/maven clean package -DskipTests

# Maven names the WAR from the POM; the vendored Dockerfile expects target/parabank.war
cp target/parabank-*.war target/parabank.war

docker build -t parabank-local .
docker run -d --name parabank -p 8080:8080 parabank-local
cd ..
```

`http://localhost:8080/parabank/index.htm` answers within a minute or two on a cold container;
the app builds its own embedded database on first request. Afterwards, `docker start parabank`.
</details>

### Configuration

`.env.example` is annotated and copies to a working `.env` unchanged except for one line.

| Variable | Needed for | Notes |
|---|---|---|
| `OPERATOR_USERNAME` / `OPERATOR_PASSWORD` | replay and discovery | ParaBank's demo login, `john` / `demo`. Synthetic. |
| `LLM_API_KEY` | **discovery only** | One key, either provider. `sk-ant-…` is detected as Anthropic, anything else as OpenAI. |
| `SUMMIT_OPERATOR_PASSWORD` etc. | optional | `<TENANT>_<ROLE>` beats the shared default, so one approved artifact serves several tenants without being edited. |

Credentials are never capability inputs. An artifact names a **logical role**
(`operator_password`) and the deployment binds it — an input would land in shell history, the
result contract, the logs and the evidence, and the leak would then have to be fought in all
four places instead of never existing.

## Running without live services

**Replay needs no model key.** That is the point of the architecture, not a convenience: the
three capabilities in `/capabilities` were learned once and cost nothing per invocation. With
`.env` holding only the two ParaBank credentials, everything below works except `discover`.

**With no ParaBank either**, 34 of the 100 tests still run — the schema and its lint,
approval, the goal reader, the overlay contract, and the architectural boundaries:

```bash
npm run typecheck
node --import tsx --test tests/artifact.test.ts tests/plan.test.ts \
  tests/overlay.test.ts tests/architecture.test.ts
```

The other 66 drive a real browser against a real application on purpose. Redaction, the
locator ladder, the error taxonomy and the handoff are all claims about behaviour on a hostile
surface, and a stubbed page would let this repository grade its own homework — several of the
bugs in the git history were found only because the target was an app we could not adjust.

`/evidence` is committed, so the runs can be read without reproducing them.

## The demo path

```bash
npm start          # ./run.sh opens this for you
```

An operator console. Pick **Discover a new capability**, describe a task in a sentence, and
watch a model work out how to do it; then pick **Replay a capability** and run what it learned
with an input it never saw.

```
  What do you want to do?
    1) Replay a capability          pick one, fill in its inputs, watch it run
    2) Discover a new capability    describe a task; the model works out how
    3) Approve a capability         sign a draft so it can run unattended
    4) Probe an unhappy path        teach a capability what going wrong looks like
    5) Walk through a handoff       pause a run, take the browser, hand it back
    6) Show what exists             capabilities, their risk, and any live sessions
```

It reads each artifact and asks for its inputs **by name**, with the type and the description
the compiler recorded — the field is `account_number`, not `accountId`, and guessing is the
usual way to hit `INPUT_VALIDATION`. Every run is headed, slowed to 700ms per action, and
recorded to `evidence/video/`.

It prints every command before running it, so it teaches the CLI rather than hiding it:

```
  $ npm run cua -- replay --id account.lookup_balance --input '{"account_number":"13122"}' --headed --slow 700 --video …

SUCCESS in 4324ms
  The current balance for account 13122 is $882.14.
```

Option 5 is worth a look — it walks the human handoff, which is otherwise four commands across
two terminals, and it spawns a real session process so the browser genuinely outlives the run.

<details>
<summary>The same three steps as raw commands</summary>

```bash
# 1. Learn. One model call per turn, and a live browser you can watch.
npm run discover -- \
  --goal 'look up account 13122 and read its current balance' \
  --id demo.lookup_balance \
  --entry 'http://localhost:8080/parabank/index.htm' \
  --credential operator_username --credential operator_password \
  --vendor parasoft --product parabank --version-range '>=5.0.0 <6.0.0' \
  --headed --slow 700

# 2. Approve. A compiled artifact is always draft; nothing self-approves.
npm run approve -- --id demo.lookup_balance --approver you@example.com

# 3. Replay, with an input the learning run never saw. No model involved.
npm run replay -- --id demo.lookup_balance --input '{"account_number":"12567"}'
```

Step 1 prints the contract it read off your sentence before it starts — the parameter, the
output and its type, and the answer template — so you can disagree with it. Step 3 prints which
ladder rung answered for every step, and whether that differed from the rung recorded at
learning time. Try step 3 before step 2 to see the approval gate refuse it.
</details>

## The rest of the surface

```bash
npm test                    # 100 tests; needs ParaBank for the integration ones
npm run cua -- list         # capabilities, their derived risk, and whether policy gates them

# The three shipped capabilities
npm run replay -- --id account.lookup_balance    --input '{"account_number":"13122"}'
npm run replay -- --id account.transfer_funds    --input '{"amount":"5.00","from_account":"13122","to_account":"12567"}'
npm run replay -- --id account.open_new_account  --input '{"funding_account_number":"13122"}'

# A business outcome: the automation worked, the answer is negative
npm run replay -- --id account.lookup_balance --input '{"account_number":"99999"}'

# A refusal: this deployment's policy does not permit that host
npm run replay -- --id account.lookup_balance --input '{"account_number":"13122"}' \
  --policy evidence/policy-wrong-environment.json
```

Useful flags: `--headed`, `--slow <ms>`, `--video <dir>`, `--tenant <name>`,
`--policy <file>`, `--evidence-root <dir>`, `--session <id>`.

### Guardrails

[`policy.json`](policy.json) is the whole of it — which risk classes need an approval, which
origins this deployment permits, which actions a discovery run may take, which `pii` tags are
treated as regulated. Drop `"safe"` from `requireApprovalFor` and a read-only lookup runs
unattended while a transfer stays gated. No code changes;
[a test proves the same draft artifact is refused under one policy and succeeds under
another](tests/policy.test.ts).

### Human handoff

When a step cannot proceed and the artifact says a person could plausibly finish it, the run
pauses and the browser stays open — the *same* browser, because the session is a separate
process, not something the run owns.

```bash
npm run session -- serve --id s1        # terminal 1: owns the browser, blocks
npm run replay  -- --id <capability> --input '{...}' --session s1
npm run takeover -- --session s1 --actor you@example.com
#   ... do the thing in the browser window ...
npm run handback -- --session s1 --actor you@example.com --note 'what you did'
npm run resume   -- --session s1
```

Resume does not restart the step that failed. It reads the page and skips whatever the page
already proves done — so if you completed three steps by hand, three steps are skipped, and
the trace says `skipped` rather than omitting them. A handback that changed nothing is refused.

`npm start` → *Walk through a handoff* does all of this in one place.

## Layout

| Path | |
|---|---|
| `src/artifact/` | the schema, its structural lint, and content-addressed approval |
| `src/surface/` | the seam. `src/surface/web/` is the only place that knows what a browser is |
| `src/replay/` | the production path: no model, ever |
| `src/discovery/` | the learning path: the model proposes, this disposes |
| `src/policy/`, `src/evidence/` | guardrails as data; masking at the write |
| `src/session/`, `src/hitl/` | custody of a live browser, and transferring it |
| `capabilities/` | three artifacts, all produced by live runs |
| `overlays/` | one example tenant overlay — design only, per §3.7 |
| `context/` | the working notes this was built from, including the competitive teardown |

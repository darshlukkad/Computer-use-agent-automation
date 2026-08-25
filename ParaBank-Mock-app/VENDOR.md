# ParaBank — vendored third-party target application

**This directory is not our code.** It is the target application our automation drives,
vendored unmodified so the demo is reproducible.

| | |
|---|---|
| Upstream | https://github.com/parasoft/parabank |
| Commit | `35069fcfa8f8f3032d3dfb3029933e2af68e83d7` (2026-08-10) |
| License | Apache License 2.0 (see `LICENSE`) |
| Vendor | Parasoft |
| Modified by us | **No.** Not one line. |

## Why this app

The brief asks for a proxy target that exercises the real problem: a legacy, server-rendered
enterprise surface with no clean DOM. Rather than building a mock — which lets the author
quietly shape the target to fit their own locator strategy — we drive a real third-party
banking application we did not write and cannot influence.

Verified properties (measured, not assumed):

- **No test IDs, no ARIA, no `<label>` elements.** On the login form the field captions are
  `<p><b>Username</b></p>` siblings with no association to the input, so both
  `getByRole("textbox", { name: "Username" })` and `getByLabel("Username")` resolve to **zero**
  elements. Only a structural/nearby-text locator finds the field. This is what makes our
  locator ladder load-bearing rather than decorative.
- **JS-populated tables.** The accounts `<tbody>` is filled after load, so replay must wait on
  a condition rather than sleep.
- **Real `<th>` table headers** — exercises the `table_header` locator strategy.
- **`jsessionid` rewritten into every URL** — the URL is not a usable checkpoint.
- **Naturally occurring exceptional states**: an empty (silent) no-results table, an internal
  error page, and session expiry. Notably, a validation error and an expired session render
  *byte-identical* text, so the error taxonomy cannot rely on banner-string matching.
- **A genuine irreversible action** with a confirmation screen: Transfer Funds →
  *"Transfer Complete! $25.00 has been transferred from account #12345…"*

## Running it

Built and run entirely in containers — no JDK or Maven is installed on the host.

```bash
# 1. build the WAR (Maven runs in a container; nothing installed locally)
cd ParaBank-Mock-app
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD":/app -v "$PWD/.m2":/var/maven/.m2 -w /app \
  -e MAVEN_CONFIG=/var/maven/.m2 \
  maven:3.9-eclipse-temurin-21 \
  mvn -q -Duser.home=/var/maven clean package -DskipTests

# 2. give the WAR the name the Dockerfile expects
#    Maven names it from the POM (parabank-5.0.0-SNAPSHOT.war); the Dockerfile copies
#    target/parabank.war. We rename rather than edit the Dockerfile, which is upstream's.
cp target/parabank-*.war target/parabank.war

# 3. build and run the image
docker build -t parabank-local .
docker run -d --name parabank -p 8080:8080 parabank-local
```

`../run.sh` does all of this, and skips whatever is already done.

Then open http://localhost:8080/parabank/index.htm — the app initializes its own embedded
HSQLDB on first request. Demo credentials are `john` / `demo`.

`target/` and `.m2/` are gitignored; only source is committed.

## Resetting state between runs

Two of our three capabilities mutate the database: one transfers money, one opens an account.
So repeated replays of `account.lookup_balance` report different balances, and each
`open_new_account` run returns a different account number.

Nothing in this repository resets the database, and that is deliberate rather than pending.
"Same inputs, same outputs" is not a property a real banking flow has — the second transfer of
the same amount is a different transfer — so asserting it would mean testing against an app
that behaves unlike the ones this is for. What is deterministic is the **decision path**: the
same steps, resolved at the same ladder rungs, with no model consulted. That is what the
traces record and what the tests assert; the tests that touch a mutating account check the
shape of the value and its agreement with the answer sentence, never a fixed figure.

If you do want a clean slate, ParaBank has a **Clean / Initialize Database** button at
`/parabank/admin.htm`, or `docker rm -f parabank && docker run …` (~40s). Neither is required
to reproduce anything here.

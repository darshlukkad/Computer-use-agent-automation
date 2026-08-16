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

# 2. build and run the image
docker build -t parabank-local .
docker run -d --name parabank -p 8080:8080 parabank-local
```

Then open http://localhost:8080/parabank/index.htm — the app initializes its own embedded
HSQLDB on first request. Demo credentials are `john` / `demo`.

`target/` and `.m2/` are gitignored; only source is committed.

## Resetting state between runs

Our capability performs a real fund transfer, which mutates the database. ParaBank exposes a
**Clean / Initialize Database** function at `/parabank/admin.htm`; the replay harness calls it
between evidence runs so that "same inputs, same outputs" holds across repeated replays.
A full reset is `docker rm -f parabank && docker run …` (~40s).

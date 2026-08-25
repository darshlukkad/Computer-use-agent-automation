# Evidence

Everything here came out of a real run against a live ParaBank. Nothing is illustrative,
edited, or reconstructed — the traces include the turns that failed.

Every file was written by the system itself, through one recorder that masks regulated
values on the way to disk. That is why account numbers appear as `[account_number:redacted]`
in the traces while the terminal output at the time showed the real figure: the caller gets
the answer, the disk gets a fingerprint. See `src/evidence/recorder.ts`.

## The discovery runs — §4's one non-negotiable

| Directory | Capability | Turns | Outcome |
|---|---|---|---|
| `discover-2026-08-19T22-44-23-333Z` | `account.lookup_balance` | 5 | success |
| `discover-2026-08-19T22-45-23-218Z` | `account.transfer_funds` | 10 | success |
| `discover-2026-08-19T22-46-10-112Z` | `account.open_new_account` | 9 | success |
| `discover-2026-08-25T20-02-50-232Z` | `account.request_loan` | 8 | **stuck** |
| `discover-2026-08-25T20-14-31-363Z` | `account.request_loan` | 10 | success |

All on `openai:gpt-5.2`.

**The stuck run is kept deliberately.** It is the more informative of the two. Pointed at
ParaBank's loan form — a screen nothing here had been tried against — the run failed, and
failed in the right way: three attempts at the amount field, then

> *"The Loan Amount textbox is resolving to a non-input table cell, so I cannot enter the
> amount."*

That diagnosis was correct, and it was a bug in our perception rather than in the model's
reasoning. The loan form separates caption from field across table cells, `<td>` counted as a
control, and in document order the cell precedes the input it holds — so a caption walk stopped
at the cell. What matters for reading this evidence is what the run did *not* do: it did not
click something else and call it done, and it did not report success. `tests/surface.test.ts`
now covers that markup, and the run at 20-14-31 is the same goal after a four-line fix.

Each holds `trace.json` (every turn: what the model saw, what it decided and why, the ladder
we synthesised from its target, which rung actually resolved, and the page before and after),
`log.jsonl`, and a screenshot per turn.

These keep their timestamped names on purpose. Each artifact's `provenance.discoveryRunId`
points at one of them, so renaming them to something tidier would leave provenance pointing
at nothing. The four capabilities in `/capabilities` were produced by these runs and by
nothing else — there is no hand-written artifact in the repository.

## The replay runs

| Directory | What it shows |
|---|---|
| `04-replay-success` | The happy path. `SUCCESS`, a typed `money` output, an answer sentence. |
| `05-replay-business-outcome` | **The exceptional state.** Account 99999 does not exist. `BUSINESS OUTCOME: ACCOUNT_NOT_FOUND` — a distinct result variant, not an error. |
| `06-replay-blocked-by-policy` | A refusal. Run under `policy-wrong-environment.json`, whose deployment allowlist does not include this host. `BLOCKED`, before a browser opened. |
| `07-handoff` | An escalation and its resolution. Two runs and the session record. |

`result.json` in each is the full result contract as a calling agent receives it, including
the per-step trace with the rung that answered and its drift against the recorded baseline.
`success.json` / `unhappy.json` / `intervention.json` are the machine-readable observations
behind the screenshots — the outcome probe reads these, which is how an exception rule gets
derived from two measured screens rather than guessed.

Two screen recordings are included (`04`, `05`). The handoff's own recording was 21 MB of a
mostly idle page, because the session process records for as long as it is open; it was
dropped rather than committed.

### 07-handoff, in order

1. `replay-…T16-09-39-415Z` — the run stops. `s4_click_log_in`'s locator points at a control
   that does not exist, standing in for a vendor renaming a button, and the step declares
   `onError: escalate`. Result: `intervention_required`, with `intervention.json` and
   `intervention.png` recording the screen it stopped on.
2. A person took the session, and a handback attempted before they touched anything was
   **refused** — resuming into an unchanged screen stops at the same step and asks again.
3. `replay-…T16-16-01-455Z` — the resumed run. `s4_click_log_in` is `skipped`, because the
   page now satisfies its postcondition; `s5_read_balance` runs and produces the answer.
4. `session-ev1.json` — custody. Three turns: automation, `alice@bank.test`, automation.
   Each carries a digest of the screen at the moment control changed hands, and the
   operator's own note. The two digests either side of their turn differ, which is the
   evidence that something happened; the screen itself is not stored, because a custody
   record is not evidence and does not pass through the masker.

The capability replayed there, `walkthrough.temporary`, was a copy of
`account.lookup_balance` with one locator deliberately broken. It was deleted afterwards —
`/capabilities` holds only the four real ones.

## Reproducing any of it

```bash
docker start parabank      # or see the README for building it

npm run replay -- --id account.lookup_balance --input '{"account_number":"13122"}'
npm run replay -- --id account.lookup_balance --input '{"account_number":"99999"}'
npm run replay -- --id account.lookup_balance --input '{"account_number":"13122"}' \
  --policy evidence/policy-wrong-environment.json
```

The balances will differ from the figures recorded here. `account.transfer_funds` and
`account.open_new_account` both draw on account 13122, and these runs happened after a lot of
them — the success above reads $882.14 where a freshly built database reads $1,100.00. That is
the application's state, not nondeterminism: the decision path is fixed, and the trace proves
which rung answered at each step. `./run.sh reset` rebuilds the database if you want to start
from ParaBank's defaults.

`npm start` walks through any of these interactively, including the handoff.

## Other files

- `artifact-account.lookup_balance.json` — a copy of one shipped artifact, so this directory
  is self-contained. The live one is `capabilities/account.lookup_balance.json`.
- `policy-wrong-environment.json` — the deployment policy used by `06`.

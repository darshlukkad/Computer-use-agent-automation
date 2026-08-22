/**
 * Step-6 gate. Pause, cede control to a person, resume — on the same browser.
 *
 * The scenario is the realistic one rather than a contrived one: the application has
 * changed and the automation can no longer find the Log In button. A person clicks it
 * by hand, hands the session back, and the run continues from where the person left
 * it — reading the balance it was asked for. Nothing is re-done.
 *
 * What makes this a test of §3.6 rather than of a mock is that the human's browser is
 * literally the automation's browser. The session process launches one Chromium with a
 * debugging port; every actor here — the run, the operator, the resumed run — is a
 * separate CDP connection to it. If a connection got its own fresh context, the
 * operator's login would be invisible to the resumed run and the last assertion would
 * fail.
 *
 * Requires: docker start parabank
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCapability } from "../src/artifact/store.ts";
import { approve } from "../src/artifact/digest.ts";
import type { Capability } from "../src/artifact/schema.ts";
import { WebDriver } from "../src/surface/web/driver.ts";
import { replay } from "../src/replay/engine.ts";
import { observationFingerprint } from "../src/surface/driver.ts";
import {
  createSession, readSession, writeSession, SESSION_DIR, type SessionRecord,
} from "../src/session/registry.ts";
import { handback, HandoffRefused, pause, stepIndexOf, takeover } from "../src/hitl/handoff.ts";

/** Distinctive so it cannot collide with a session a person actually started. */
const SESSION_ID = "test-handoff";
const PORT = 9411;
const INPUTS = { account_number: "13122" };
const evidenceRoot = mkdtempSync(join(tmpdir(), "cua-handoff-"));

process.env.OPERATOR_USERNAME ??= "john";
process.env.OPERATOR_PASSWORD ??= "demo";

/**
 * The capability, with the Log In button's locator broken and the step told that a
 * person could plausibly finish it.
 *
 * Re-approved after editing, because editing an approved artifact invalidates its
 * digest — which is the point of the digest, and a test that worked around it would be
 * testing a system nobody ships.
 */
function withUnfindableLogin(): Capability {
  const base = loadCapability("account.lookup_balance").artifact;
  const a = JSON.parse(JSON.stringify(base)) as Capability;
  const step = a.steps.find((s) => s.id === "s4_click_log_in")!;
  step.target = {
    strategies: [{ kind: "role_name", role: "button", name: "Sign On With Passkey" }],
    baselineRung: 1,
    rationale: "Deliberately absent: stands in for the vendor renaming this control.",
  };
  step.onError = "escalate";
  return approve(a, "test@local");
}

/** The long-lived process's role: owns the browser, does nothing else. */
let sessionDriver: WebDriver;
let record: SessionRecord;

/** Every actor gets its own connection, exactly as a separate process would. */
const connect = async (inputs: Record<string, string> = {}): Promise<WebDriver> => {
  const d = new WebDriver({ cdpEndpoint: record.cdpEndpoint, inputs });
  await d.launch();
  return d;
};

before(async () => {
  sessionDriver = new WebDriver({ remoteDebuggingPort: PORT });
  await sessionDriver.launch();
  await sessionDriver.act({ action: "navigate", url: "about:blank" });
  record = createSession(SESSION_ID, `http://localhost:${PORT}`, process.pid);
});

after(async () => {
  await sessionDriver.close();
  rmSync(join(SESSION_DIR, `${SESSION_ID}.json`), { force: true });
});

// --- a run bound to a session stops without losing the screen --------------

test("an escalating step pauses the run and leaves the session open", async () => {
  const driver = await connect(INPUTS);
  const artifact = withUnfindableLogin();
  const result = await replay({ artifact, inputs: INPUTS, driver, evidenceRoot });
  await driver.close();

  assert.equal(result.status, "intervention_required", JSON.stringify(result, null, 2));
  if (result.status !== "intervention_required") return;
  assert.equal(result.stepId, "s4_click_log_in");
  assert.match(result.reason, /onError=escalate/);

  record = pause(record, artifact, result, INPUTS, null);
  assert.equal(record.pending?.stepIndex, stepIndexOf(artifact, "s4_click_log_in"));

  // The whole point: the run's browser is still there, still on the login screen with
  // the username and password the automation typed.
  const check = await connect();
  const obs = await check.observe();
  assert.match(obs.url, /parabank/);
  assert.equal(await check.readValue({
    strategies: [{ kind: "nearby_text", text: "Username", direction: "below" }],
    baselineRung: 1, rationale: "reading back what the run typed",
  }), "john");
  await check.close();
});

// --- custody is exclusive and recorded ------------------------------------

test("taking control records who holds it and what they were shown", async () => {
  const driver = await connect();
  const { record: after, url } = await takeover(record, driver, "alice@bank.test");
  record = after;
  await driver.close();

  assert.equal(record.owner, "human");
  const turn = record.actors.at(-1)!;
  assert.equal(turn.actor, "alice@bank.test");
  assert.equal(turn.role, "human");
  assert.ok(turn.fingerprintBefore, "the screen at the moment of transfer is recorded");
  assert.match(url, /parabank/);

  // The automation's turn is closed, not left open. Two open turns would mean two
  // actors believing they may act.
  const previous = record.actors.at(-2)!;
  assert.equal(previous.actor, "automation");
  assert.ok(previous.released);
});

test("a second takeover is refused while a person holds the session", async () => {
  const driver = await connect();
  await assert.rejects(
    () => takeover(record, driver, "bob@bank.test"),
    (e: Error) => e instanceof HandoffRefused && /already holds/.test(e.message),
  );
  await driver.close();
});

test("a handback that changed nothing is refused", async () => {
  // Resuming into an unchanged blocker stops at the same step and escalates again.
  const driver = await connect(INPUTS);
  const artifact = withUnfindableLogin();
  await assert.rejects(
    () => handback(record, driver, artifact, { actor: "alice@bank.test" }),
    (e: Error) => e instanceof HandoffRefused && /unchanged since you took control/.test(e.message),
  );
  await driver.close();
});

test("a handback from someone who does not hold the session is refused", async () => {
  const driver = await connect(INPUTS);
  await assert.rejects(
    () => handback(record, driver, withUnfindableLogin(), { actor: "bob@bank.test" }),
    (e: Error) => e instanceof HandoffRefused && /held by alice@bank.test/.test(e.message),
  );
  await driver.close();
});

// --- the person does the thing the automation could not -------------------

test("the operator acts on the automation's own screen", async () => {
  const human = await connect();
  const before = observationFingerprint(await human.observe());

  // What a person would actually do: click the button the automation could not find.
  // This is the real control, on the real page, in the real session.
  await human.act({
    action: "click",
    target: {
      strategies: [{ kind: "role_name", role: "button", name: "Log In" }],
      baselineRung: 1, rationale: "the operator's own click",
    },
  });
  await human.livePage().waitForURL(/overview/, { timeout: 20_000 });

  const obs = await human.observe();
  assert.match(obs.text, /Accounts Overview/);
  assert.notEqual(observationFingerprint(obs), before);
  await human.close();
});

test("handback reports what the person completed and where the run will resume", async () => {
  const driver = await connect(INPUTS);
  const artifact = withUnfindableLogin();
  const result = await handback(record, driver, artifact, {
    actor: "alice@bank.test",
    note: "Vendor renamed the sign-in control; clicked it by hand.",
  });
  record = result.record;
  await driver.close();

  assert.equal(result.changed, true);
  assert.equal(record.owner, "automation");

  // The step the automation could not do is now proved done by the page itself, so the
  // run will not attempt it again.
  assert.deepEqual(result.plan.skipped, ["s4_click_log_in"]);
  assert.equal(artifact.steps[result.plan.index]!.id, "s5_read_balance");

  // What the person did is on the record, in their words and in measured state.
  const theirTurn = record.actors.find((t) => t.actor === "alice@bank.test")!;
  assert.match(theirTurn.note ?? "", /clicked it by hand/);
  assert.ok(theirTurn.released);
  assert.notEqual(theirTurn.fingerprintBefore, theirTurn.fingerprintAfter);
});

test("the custody record holds no page contents", () => {
  // Regression. The first version stored the raw fingerprint, so every entry was a
  // full copy of the screen — the whole account table, in a file that is not evidence
  // and never passes through the masker. Equality is all this record ever needs.
  const record = readSession(SESSION_ID);
  const raw = JSON.stringify(record);

  assert.doesNotMatch(raw, /Accounts Overview/, "page text reached the session record");
  assert.doesNotMatch(raw, /Balance\*/, "the account table reached the session record");
  for (const turn of record.actors) {
    for (const fp of [turn.fingerprintBefore, turn.fingerprintAfter]) {
      if (fp) assert.match(fp, /^fp_[0-9a-f]{12}$/, `not a digest: ${fp.slice(0, 40)}`);
    }
  }

  // What it does carry is the paused run's own inputs, because resuming without them
  // is impossible and asking the operator to retype them defeats the handoff. Their
  // retention is bounded by the pause: `pending` is cleared the moment the run ends,
  // and the file itself goes when the session does.
  assert.equal(record.pending?.inputs.account_number, "13122");
});

// --- and the run finishes what it started --------------------------------

test("the resumed run skips what was done and returns the answer", async () => {
  const driver = await connect(INPUTS);
  const artifact = withUnfindableLogin();
  const result = await replay({
    artifact,
    inputs: INPUTS,
    driver,
    evidenceRoot,
    // The operator's session is exactly the state we want; a fresh one would discard
    // the login they just performed.
    freshSession: false,
    resumeFrom: record.pending!.stepIndex,
  });
  await driver.close();

  assert.equal(result.status, "success", JSON.stringify(result, null, 2));
  if (result.status !== "success") return;

  // The step whose locator is broken never ran, and the run still succeeded.
  const login = result.trace.find((t) => t.stepId === "s4_click_log_in")!;
  assert.equal(login.outcome, "skipped");
  assert.equal(result.trace.find((t) => t.stepId === "s5_read_balance")!.outcome, "ok");

  // A skipped step is recorded, not omitted: a trace missing its login steps is
  // indistinguishable from a run that never logged in.
  assert.ok(result.trace.some((t) => t.outcome === "skipped"));

  const balance = result.outputs.current_balance as { currency: string; minorUnits: number };
  assert.equal(balance.currency, "USD");
  assert.match(result.answer ?? "", /^The current balance for account 13122 is/);

  record.pending = null;
  writeSession(record);
  assert.equal(readSession(SESSION_ID).pending, null);
});

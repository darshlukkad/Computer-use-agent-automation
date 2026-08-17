/**
 * Step-2 gate. Integration tests against a live ParaBank.
 *
 * These are not unit tests with a stubbed page — the whole point is that the ladder
 * survives a real third-party legacy surface we did not write and cannot modify.
 * They also verify the `baselineRung` values asserted in the artifact, so those are
 * measured facts rather than claims.
 *
 * Requires: docker run -d --name parabank -p 8080:8080 parabank-local
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { WebDriver } from "../src/surface/web/driver.ts";
import { TargetAmbiguous, TargetMissing } from "../src/surface/driver.ts";
import { parseCapability, type Capability, type Target } from "../src/artifact/schema.ts";

const BASE = "http://localhost:8080/parabank";
const CREDS = { user: "john", pass: "demo" };

const artifact: Capability = parseCapability(
  JSON.parse(readFileSync("capabilities/account.lookup_balance.handwritten.json", "utf8")),
);
const targetOf = (id: string): Target => artifact.steps.find((s) => s.id === id)!.target!;

let driver: WebDriver;

before(async () => {
  driver = new WebDriver({ inputs: { accountId: "13122" } });
  await driver.launch();
  await driver.act({ action: "navigate", url: `${BASE}/index.htm` });
});

after(async () => { await driver.close(); });

// --- perception ------------------------------------------------------------

test("the walker reports unnamed controls honestly, with their visible caption", async () => {
  const obs = await driver.observe();
  const textboxes = obs.nodes.filter((n) => n.role === "textbox");
  assert.ok(textboxes.length >= 2, "expected the login fields");

  // ParaBank gives these inputs no id, no <label>, no aria-label. The accessible
  // name IS empty, and saying otherwise would be a lie that hides why the ladder
  // exists. What makes them identifiable is the caption a human reads.
  const username = textboxes.find((n) => n.nearbyText === "Username");
  assert.ok(username, `no textbox captioned 'Username'; saw ${JSON.stringify(textboxes)}`);
  assert.equal(username.name, "", "the field genuinely has no accessible name");

  assert.ok(textboxes.some((n) => n.nearbyText === "Password"));
});

test("a password field's contents never enter an observation", async () => {
  await driver.act({ action: "fill", target: targetOf("s3_password"), value: CREDS.pass });
  const obs = await driver.observe();
  assert.doesNotMatch(JSON.stringify(obs), new RegExp(CREDS.pass, "i"));
});

// --- the ladder, measured --------------------------------------------------

test("rungs 1 and 2 genuinely find nothing on the login fields", async () => {
  const full = targetOf("s2_username");
  for (const [i, strategy] of full.strategies.slice(0, 2).entries()) {
    const solo = { ...full, strategies: [strategy], baselineRung: 1 };
    assert.equal(await driver.count(solo), 0,
      `rung ${i + 1} (${strategy.kind}) should match nothing on this app`);
  }
});

test("rung 3 resolves the field, confirming the recorded baseline", async () => {
  const target = targetOf("s2_username");
  const res = await driver.resolve(target);
  assert.equal(res.rung, 3, "nearby_text is the only rung that works here");
  assert.equal(res.strategy.kind, "nearby_text");
  assert.equal(res.matchCount, 1);
  // The claim written into the artifact must match observed reality.
  assert.equal(target.baselineRung, res.rung);
});

test("role_name does resolve the submit button, as the artifact predicts", async () => {
  // <input type=submit> takes its accessible name from the value attribute, so
  // rung 1 holds here even though the text fields on the same form have no name.
  const target = targetOf("s4_signin");
  const res = await driver.resolve(target);
  assert.equal(res.rung, 1);
  assert.equal(res.strategy.kind, "role_name");
  assert.equal(target.baselineRung, res.rung);
});

test("an unmatchable target reports every rung it tried", async () => {
  const target: Target = {
    strategies: [{ kind: "role_name", role: "button", name: "Wire Transfer" }],
    baselineRung: 1,
    rationale: "deliberately absent",
  };
  await assert.rejects(() => driver.resolve(target), TargetMissing);
  await assert.rejects(() => driver.resolve(target), /role_name\(button, "Wire Transfer"\)=0/);
});

test("an ambiguous target is refused rather than guessed", async () => {
  // Many links match; picking .first() here is how automation clicks the wrong row.
  const target: Target = {
    strategies: [{ kind: "css", selector: "a" }],
    baselineRung: 1,
    rationale: "deliberately ambiguous",
  };
  await assert.rejects(() => driver.resolve(target), TargetAmbiguous);
});

// --- the multi-screen flow -------------------------------------------------

test("the ladder drives login end to end", async () => {
  await driver.act({ action: "navigate", url: `${BASE}/index.htm` });
  await driver.act({ action: "fill", target: targetOf("s2_username"), value: CREDS.user });
  await driver.act({ action: "fill", target: targetOf("s3_password"), value: CREDS.pass });
  await driver.act({ action: "click", target: targetOf("s4_signin") });

  await driver.livePage().waitForURL(/overview/, { timeout: 20_000 });
  const obs = await driver.observe();
  assert.match(obs.text, /Accounts Overview/);
});

test("count() tolerates many matches where resolve() would refuse", async () => {
  const rows = artifact.steps.find((s) => s.id === "s5_await_rows")!.postcondition!;
  assert.equal(rows.kind, "count_at_least");
  const target = (rows as { target: Target }).target;

  await driver.livePage().waitForFunction(
    () => document.querySelectorAll("#accountTable tbody tr").length > 0,
    null, { timeout: 20_000 },
  );
  assert.ok(await driver.count(target) > 1, "the accounts table has many rows");
  // The same target through resolve() is ambiguous — which is correct, and is why
  // conditions and actions use different primitives.
  await assert.rejects(() => driver.resolve(target), TargetAmbiguous);
});

test("table_cell reads a balance by column header and row content", async () => {
  const balance = await driver.readText(targetOf("s6_read_balance"));
  assert.match(balance, /^-?\$[\d,]+\.\d{2}$/, `unexpected balance format: ${balance}`);
});

test("table_cell finds nothing for an account that is not listed", async () => {
  // The business-outcome path: the automation works, the answer is negative.
  driver.setInputs({ accountId: "99999" });
  await assert.rejects(() => driver.readText(targetOf("s6_read_balance")), TargetMissing);
  driver.setInputs({ accountId: "13122" });
});

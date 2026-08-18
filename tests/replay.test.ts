/**
 * Step-3 gate. Deterministic replay against live ParaBank, with no model involved.
 *
 * The load-bearing assertions are the ones about *classification*: a missing
 * account must come back as a business outcome, not an error, and a refusal must be
 * distinguishable from a breakage.
 *
 * Requires: docker start parabank
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCapability, type Capability } from "../src/artifact/schema.ts";
import { approve } from "../src/artifact/digest.ts";
import { WebDriver } from "../src/surface/web/driver.ts";
import { replay } from "../src/replay/engine.ts";
import { parseMoney, resolveSecret, validateInputs, ValueError } from "../src/replay/values.ts";

const FIXTURE = "capabilities/account.lookup_balance.handwritten.json";
const load = (): Capability =>
  parseCapability(JSON.parse(readFileSync(FIXTURE, "utf8")));

const evidenceRoot = mkdtempSync(join(tmpdir(), "cua-evidence-"));
let driver: WebDriver;

// The artifact names a logical role; the deployment binds it. Nothing about this
// institution appears in the artifact.
process.env.OPERATOR_USERNAME ??= "john";
process.env.OPERATOR_PASSWORD ??= "demo";

const run = (inputs: Record<string, string>, artifact = approve(load(), "test@local")) =>
  replay({ artifact, inputs, driver, evidenceRoot });

before(async () => {
  driver = new WebDriver({});
  await driver.launch();
});
after(async () => { await driver.close(); });

// --- money is never a float ------------------------------------------------

test("money parses to integer minor units", () => {
  assert.deepEqual(parseMoney("$1,100.00"), { currency: "USD", minorUnits: 110000 });
  assert.deepEqual(parseMoney("-$2,300.00"), { currency: "USD", minorUnits: -230000 });
  assert.deepEqual(parseMoney("$0.45"), { currency: "USD", minorUnits: 45 });
  // 1234.56 * 100 is 123455.99999999999 in binary floating point.
  assert.deepEqual(parseMoney("$1,234.56"), { currency: "USD", minorUnits: 123456 });
});

// --- the boundary rejects bad input before opening a browser ---------------

test("a malformed input never reaches the browser", async () => {
  const result = await run({ accountId: "not-an-account" });
  assert.equal(result.status, "failure");
  assert.equal(result.status === "failure" && result.code, "INPUT_VALIDATION");
  assert.deepEqual(result.trace, [], "nothing should have executed");
});

test("input validation withholds the value it rejected", () => {
  // accountId is tagged pii: "identifier"; the message must not echo it back.
  try {
    validateInputs(load().signature.inputs, { accountId: "123-45-6789" });
    assert.fail("expected a rejection");
  } catch (e) {
    assert.ok(e instanceof ValueError);
    assert.doesNotMatch(e.message, /123-45-6789/);
  }
});

// --- refusing is not failing ----------------------------------------------

test("a draft capability is blocked, not failed", async () => {
  const result = await replay({ artifact: load(), inputs: { accountId: "13122" }, driver, evidenceRoot });
  assert.equal(result.status, "blocked");
  assert.equal(result.status === "blocked" && result.policyRule, "approval-required");
  // The distinction matters to the caller: the remedy is review, not debugging.
});

test("an approved artifact edited afterwards is blocked as tampered", async () => {
  const approved = approve(load(), "reviewer@example.com");
  approved.steps[5]!.maxAttempts = 5;
  const result = await replay({ artifact: approved, inputs: { accountId: "13122" }, driver, evidenceRoot });
  assert.equal(result.status, "blocked");
  assert.match(result.status === "blocked" ? result.reason : "", /content changed/);
});

// --- the happy path --------------------------------------------------------

test("replay returns a typed balance with no model in the loop", async () => {
  const result = await run({ accountId: "13122" });
  assert.equal(result.status, "success", JSON.stringify(result, null, 2));
  if (result.status !== "success") return;

  const balance = result.outputs.balance as { currency: string; minorUnits: number };
  assert.equal(balance.currency, "USD");
  assert.equal(typeof balance.minorUnits, "number");
  assert.equal(Number.isInteger(balance.minorUnits), true);
  assert.deepEqual(result.recoveries, []);
});

test("every step records which rung answered, and its drift", async () => {
  const result = await run({ accountId: "13122" });
  assert.equal(result.status, "success");
  if (result.status !== "success") return;

  const username = result.trace.find((t) => t.stepId === "s2_username")!;
  // Measured in step 2: rungs 1 and 2 find nothing on this app, so 3 is healthy.
  assert.equal(username.resolvedRung, 3);
  assert.equal(username.baselineRung, 3);
  assert.equal(username.drift, "none");

  const signin = result.trace.find((t) => t.stepId === "s4_signin")!;
  assert.equal(signin.resolvedRung, 1);
  assert.equal(signin.drift, "none");

  assert.ok(result.trace.every((t) => t.drift !== "degraded"),
    "a healthy run against an unchanged app must report no degradation");
});

test("replay is deterministic across runs", async () => {
  const a = await run({ accountId: "13122" });
  const b = await run({ accountId: "13122" });
  assert.equal(a.status, "success");
  assert.equal(b.status, "success");
  if (a.status !== "success" || b.status !== "success") return;

  assert.deepEqual(a.outputs, b.outputs);
  assert.deepEqual(
    a.trace.map((t) => [t.stepId, t.resolvedRung]),
    b.trace.map((t) => [t.stepId, t.resolvedRung]),
    "same inputs, same steps, same rungs",
  );
});

// --- credentials are a runtime binding, not a capability input ------------

test("no credential is a declared input, and none is persisted", async () => {
  const a = load();
  // If a credential were an input it would land in shell history, the result
  // contract, logs and evidence. It is not in the contract at all.
  assert.deepEqual(Object.keys(a.signature.inputs), ["accountId"]);

  const result = await run({ accountId: "13122" });
  const persisted = readFileSync(join(result.evidenceDir, "result.json"), "utf8");
  assert.doesNotMatch(persisted, /john|demo/i);
});

test("the artifact names a logical role, not an institution or a variable", () => {
  const refs = load().steps
    .filter((s) => s.value?.kind === "secret")
    .map((s) => (s.value as { ref: string }).ref);

  assert.deepEqual(refs, ["operator_username", "operator_password"]);
  // Baking SUMMIT_PASSWORD into the artifact would make it tenant-specific, so
  // reusing it would require an edit — invalidating the digest and forcing
  // re-approval for what is purely deployment configuration.
  for (const ref of refs) {
    assert.doesNotMatch(ref, /parabank|summit/i);
  }
});

test("a tenant-scoped credential wins over the shared default", () => {
  process.env.SUMMIT_OPERATOR_PASSWORD = "tenant-specific";
  try {
    assert.equal(resolveSecret("operator_password", "summit"), "tenant-specific");
    assert.equal(resolveSecret("operator_password", null), "demo");
    // Falls back to the shared credential when the tenant has none of its own.
    assert.equal(resolveSecret("operator_username", "summit"), "john");
  } finally {
    delete process.env.SUMMIT_OPERATOR_PASSWORD;
  }
});

test("an unbound credential names the variables it looked for, never a value", () => {
  try {
    resolveSecret("wire_approval_pin", "summit");
    assert.fail("expected a rejection");
  } catch (e) {
    assert.match((e as Error).message, /SUMMIT_WIRE_APPROVAL_PIN, WIRE_APPROVAL_PIN/);
  }
});

// --- the one the brief singles out ----------------------------------------

test("an account that does not exist is a business outcome, not a failure", async () => {
  const result = await run({ accountId: "99999" });

  assert.equal(result.status, "business_outcome",
    `expected a business outcome, got ${result.status}`);
  if (result.status !== "business_outcome") return;

  assert.equal(result.code, "ACCOUNT_NOT_FOUND");
  // The caller branches on a constant from the reviewed artifact, never on prose.
  assert.ok(result.observed.length > 0);
});

test("a business outcome is structurally not an error", async () => {
  const result = await run({ accountId: "99999" });
  // No `code: FailureCode`, no `safeToRetry`, no `expected`. A caller cannot
  // mistake this for a crash because the fields for one are not present.
  assert.equal("safeToRetry" in result, false);
  assert.equal("expected" in result, false);
});

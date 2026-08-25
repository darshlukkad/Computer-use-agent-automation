/**
 * Step-1 gate. These tests prove the schema is sound before a replay engine is
 * built on top of it, and that approval is enforceable rather than decorative.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  parseCapability,
  ArtifactInvalid,
  type Capability,
} from "../src/artifact/schema.ts";
import { approve, verifyApproval, artifactDigest, canonicalJson } from "../src/artifact/digest.ts";
import { classifyDrift } from "../src/result/types.ts";

/**
 * Hand-written on purpose, and kept out of capabilities/ so it is never mistaken for a
 * shipped one. It exists because the schema had to be proved able to express a real
 * legacy flow before a replay engine was built on it — writing it by hand is what
 * surfaced two schema gaps early.
 *
 * It used to be the only artifact carrying exception rules; the outcome probe ended
 * that, and `tests/replay.test.ts` now proves the business-outcome path on a
 * discovered artifact instead. What it is still good for is the lint tests below,
 * which need an artifact that can be deliberately broken in specific ways — and
 * hand-crafting the invalid input is the point of a lint test.
 */
const FIXTURE = "tests/fixtures/lookup_balance.handwritten.json";
/**
 * Normalised to draft so tests do not depend on whether someone has run
 * `cli approve` against the fixture on disk. Anything needing an approved artifact
 * approves it explicitly.
 */
const load = (): Capability => {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  const meta = raw.metadata as Record<string, unknown>;
  delete meta.digest;
  delete meta.approval;
  meta.status = "draft";
  return parseCapability(raw);
};
/** Structured clone so a mutation in one test cannot leak into another. */
const clone = (a: Capability): Capability => JSON.parse(JSON.stringify(a)) as Capability;

// --- the schema can express a real legacy flow -----------------------------

test("the real ParaBank flow round-trips through the schema", () => {
  const a = load();
  assert.equal(a.metadata.id, "account.lookup_balance");
  assert.equal(a.steps.length, 6);
  assert.equal(a.signature.inputs.accountId?.pii, "identifier");
  assert.equal(a.signature.outputs.balance?.type, "money");
});

test("credentials are referenced, never embedded", () => {
  const a = load();
  const serialized = JSON.stringify(a);
  assert.match(serialized, /"kind":"secret"/);
  // The fixture must not carry a literal credential anywhere.
  assert.doesNotMatch(serialized, /"john"|"demo"/i);

  for (const step of a.steps) {
    if (step.value?.kind !== "secret") continue;
    // A secret fill may not be proved with value_equals — that would write the
    // credential into the artifact. This is why value_non_empty exists.
    assert.notEqual(step.postcondition?.kind, "value_equals",
      `step ${step.id} would serialize a secret into its postcondition`);
  }
});

test("the locator ladder is ordered semantic-first, CSS last", () => {
  const a = load();
  for (const step of a.steps) {
    if (!step.target) continue;
    const kinds = step.target.strategies.map((s) => s.kind);
    const cssAt = kinds.indexOf("css");
    if (cssAt !== -1) {
      assert.equal(cssAt, kinds.length - 1,
        `step ${step.id}: css must be the last rung, found at ${cssAt} of ${kinds.length}`);
    }
    assert.ok(step.target.rationale.length > 20,
      `step ${step.id}: every locator must carry its robustness reasoning`);
  }
});

// --- drift is measured against a baseline, not against rung 1 --------------

test("aspirational upper rungs do not report drift on a healthy run", () => {
  const a = load();
  // ParaBank's login fields carry role_name and label rungs that resolve to zero
  // elements and always will. Naive "drift = deeper than rung 1" would fire on
  // every run forever, and an alert that always fires gets muted.
  const username = a.steps.find((s) => s.id === "s2_username")!;
  assert.equal(username.target!.strategies.length, 3);
  assert.equal(username.target!.baselineRung, 3);
  assert.equal(classifyDrift(username.target!.baselineRung, 3), "none");
});

test("drift is degraded when the ladder falls further than recorded", () => {
  assert.equal(classifyDrift(1, 2), "degraded");
  assert.equal(classifyDrift(3, 4), "degraded");
});

test("drift is improved when the app gains better semantics", () => {
  // A vendor upgrade that finally adds a <label> lets rung 2 win where rung 3 used
  // to. Worth surfacing so the baseline can be tightened, not silently ignored.
  assert.equal(classifyDrift(3, 2), "improved");
});

test("a step with no target has no drift signal", () => {
  assert.equal(classifyDrift(1, null), "none");
});

test("a baseline past the end of its ladder is rejected", () => {
  const a = clone(load());
  a.steps[3]!.target!.baselineRung = 5; // ladder has 2 rungs
  assert.throws(() => parseCapability(a), /exceeds its 2-rung ladder/);
});

// --- structural lint catches what the type system cannot -------------------

test("a mutating step without a postcondition is rejected", () => {
  const a = clone(load());
  delete (a.steps[3] as { postcondition?: unknown }).postcondition; // s4_signin, a click
  assert.throws(() => parseCapability(a), ArtifactInvalid);
});

test("retrying a non-idempotent step is rejected", () => {
  const a = clone(load());
  a.steps[3]!.effect = "irreversible_mutation";
  a.steps[3]!.maxAttempts = 3;
  assert.throws(() => parseCapability(a), /not retry-safe/);
});

test("a recoverable exception without a recovery plan is rejected", () => {
  const a = clone(load());
  delete (a.exceptions[1] as { recover?: unknown }).recover;
  assert.throws(() => parseCapability(a), /declares no recovery plan/);
});

test("a declared output that nothing extracts is rejected", () => {
  const a = clone(load());
  a.signature.outputs.accountHolder = {
    type: "string", required: true, pii: "name", description: "",
  };
  assert.throws(() => parseCapability(a), /nothing extracts/);
});

test("an extraction referencing an unknown step is rejected", () => {
  const a = clone(load());
  a.success.extract[0]!.from = "s99_nonexistent";
  assert.throws(() => parseCapability(a), /unknown step/);
});

// --- approval is enforceable, not a label ---------------------------------

test("approval binds a digest to the artifact's content", () => {
  const approved = approve(load(), "reviewer@example.com");
  assert.equal(approved.metadata.status, "approved");
  assert.equal(approved.metadata.approval?.digest, approved.metadata.digest);
  assert.deepEqual(verifyApproval(approved), { valid: true });
});

test("editing an approved artifact invalidates it", () => {
  const approved = approve(load(), "reviewer@example.com");
  const tampered = clone(approved);
  // A plausible-looking edit that changes real behaviour.
  tampered.steps[5]!.maxAttempts = 5;

  const check = verifyApproval(tampered);
  assert.equal(check.valid, false);
  assert.match((check as { reason: string }).reason, /content changed since approval/);
});

test("flipping status to approved by hand does not pass", () => {
  const forged = clone(load());
  forged.metadata.status = "approved";
  const check = verifyApproval(forged);
  assert.equal(check.valid, false);
  assert.match((check as { reason: string }).reason, /no digest/);
});

/** Rebuild every object with its keys in reverse insertion order. */
function shuffleKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shuffleKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .reverse()
        .map(([k, val]) => [k, shuffleKeys(val)]),
    );
  }
  return v;
}

test("the digest ignores key order so a formatter cannot invalidate approvals", () => {
  const a = load();
  const reordered = shuffleKeys(a) as Capability;

  // Guard the test itself: the inputs must genuinely differ before canonicalization.
  assert.notEqual(JSON.stringify(a), JSON.stringify(reordered));

  assert.equal(canonicalJson(a), canonicalJson(reordered));
  assert.equal(artifactDigest(a), artifactDigest(reordered));
  assert.deepEqual(verifyApproval(approve(reordered, "reviewer@example.com")), { valid: true });
});

// --- the multi-tenant claim must not be blocked by the type system --------

test("the schema carries no application-specific literal", () => {
  // A second, entirely different vendor product must be representable. If this
  // fails, any multi-tenant story in the report is fiction.
  const a = clone(load());
  a.metadata.id = "member.lookup_savings";
  a.compatibility = { vendor: "fiserv", product: "signature", versionRange: ">=2.0.0 <3.0.0" };
  a.entry = { originAllowlist: ["https://core.example.test"], path: "/cu/teller/home" };
  assert.doesNotThrow(() => parseCapability(a));
});
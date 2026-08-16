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

const FIXTURE = "capabilities/account.lookup_balance.handwritten.json";
const load = (): Capability => parseCapability(JSON.parse(readFileSync(FIXTURE, "utf8")));
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
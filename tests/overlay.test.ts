/**
 * The multi-tenant answer, held to the artifact it claims to patch.
 *
 * §3.7 puts multi-tenant execution out of scope and asks for the design instead, so
 * nothing merges overlays at runtime. What that leaves is a contract, and a contract
 * nobody checks is a paragraph in a report.
 *
 * These are the two things worth checking without building the plumbing. First, that
 * the overlay actually corresponds to the base artifact — a `locators` key naming a
 * step that does not exist, or a `copy` rewrite of a label the base never uses, is a
 * silent no-op, and silent no-ops are how a tenant ends up running the base flow while
 * everyone believes it was specialised. Second, that the overlay type cannot express a
 * change to the safety model, whatever anyone writes in it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseOverlay, type Capability, type TenantOverlay } from "../src/artifact/schema.ts";
import { loadCapability } from "../src/artifact/store.ts";

const OVERLAY = "overlays/summit.account_lookup_balance.json";

const overlay: TenantOverlay = parseOverlay(JSON.parse(readFileSync(OVERLAY, "utf8")));
const base: Capability = loadCapability(overlay.metadata.appliesTo.capabilityId).artifact;

/** Every string anywhere in the parts of an artifact an overlay could rewrite. */
function stringsIn(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, found));
  else if (value && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((v) => stringsIn(v, found));
  }
  return found;
}

test("the overlay names a capability that exists, at a compatible version", () => {
  assert.equal(base.metadata.id, "account.lookup_balance");
  assert.equal(overlay.compatibility.vendor, base.compatibility.vendor);
  assert.equal(overlay.compatibility.product, base.compatibility.product);
  // Patching a different vendor's product would be a fork wearing an overlay's clothes.
});

test("every locator override names a step the base artifact has", () => {
  const stepIds = new Set(base.steps.map((s) => s.id));
  for (const stepId of Object.keys(overlay.locators)) {
    assert.ok(stepIds.has(stepId),
      `overlay overrides '${stepId}', which the base artifact does not have — a silent no-op`);
  }
});

test("every copy rewrite renames something the base artifact actually says", () => {
  // A rewrite of a label the base never uses does nothing, and reads as though the
  // tenant's difference has been handled when it has not.
  const said = new Set(stringsIn({ steps: base.steps, preconditions: base.preconditions, success: base.success, exceptions: base.exceptions }));
  for (const from of Object.keys(overlay.copy)) {
    assert.ok([...said].some((s) => s.includes(from)),
      `overlay rewrites ${JSON.stringify(from)}, which appears nowhere in the base artifact`);
  }
});

test("an overridden locator is still identified by meaning, not by position", () => {
  // The point of the ladder survives the override, or the overlay has quietly traded
  // robustness for a tenant-specific selector.
  for (const [stepId, target] of Object.entries(overlay.locators)) {
    assert.ok(target.strategies.length >= 1, `${stepId} has no strategies`);
    const kinds = target.strategies.map((s) => s.kind);
    const cssAt = kinds.indexOf("css");
    if (cssAt !== -1) {
      assert.equal(cssAt, kinds.length - 1, `${stepId}: css must remain the last rung`);
    }
    assert.ok(target.rationale.length > 20, `${stepId}: an override needs its reasoning too`);
  }
});

test("an overlay cannot express a change to the safety model", () => {
  // The guarantee is structural: there is no field in which to say it. A validator
  // can be bypassed by whoever adds the next convenient escape hatch; an absent
  // field cannot. This test fails the moment someone adds one.
  const forbidden = ["risk", "effect", "signature", "exceptions", "steps", "success", "maxAttempts"];
  const declared = Object.keys(overlay);
  for (const key of forbidden) {
    assert.ok(!declared.includes(key),
      `TenantOverlay accepted a '${key}' field — a tenant config file can now edit the safety model`);
  }

  // And a document that tries anyway is rejected rather than quietly ignored.
  const smuggled = {
    ...JSON.parse(readFileSync(OVERLAY, "utf8")),
    steps: [{ id: "s4_click_log_in", risk: "safe", effect: "observation" }],
  };
  assert.throws(() => parseOverlay(smuggled), /unrecognized_keys|Unrecognized/i);
});

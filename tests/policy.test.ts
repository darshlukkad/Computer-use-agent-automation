/**
 * Step-5 gate. Guardrails are data, and redaction actually happens.
 *
 * Two claims are being tested, and both are the kind that are easy to assert in a
 * README and never true in the code:
 *
 *   - The policy file is load-bearing. Editing one line in JSON must change what the
 *     system will do, with no code change. The live test at the bottom proves it by
 *     running an unapproved capability that the shipped policy would refuse.
 *   - Nothing regulated reaches disk. Not just the answer sentence — the trace, the
 *     log, and the page observations inside them.
 *
 * Requires: docker start parabank (for the last test only)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCapability, type Capability } from "../src/artifact/schema.ts";
import {
  capabilityRisk, loadPolicy, originPermitted, actionPermitted, requiresApproval,
  redacts, resetPolicyCache, DEFAULT_POLICY, PolicyInvalid, POLICY_PATH, type Policy,
} from "../src/policy/policy.ts";
import { makeMasker, maskedInputs, Recorder } from "../src/evidence/recorder.ts";
import { WebDriver } from "../src/surface/web/driver.ts";
import { replay } from "../src/replay/engine.ts";

const FIXTURE = "tests/fixtures/lookup_balance.handwritten.json";
const load = (): Capability => {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
  const meta = raw.metadata as Record<string, unknown>;
  delete meta.digest;
  delete meta.approval;
  meta.status = "draft";
  return parseCapability(raw);
};

const scratch = mkdtempSync(join(tmpdir(), "cua-policy-"));
const writePolicy = (name: string, body: unknown): string => {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};

// --- the shipped policy is the strict one ----------------------------------

test("the committed policy.json parses and gates every risk class", () => {
  const shipped = loadPolicy(POLICY_PATH);
  assert.deepEqual(shipped.replay.requireApprovalFor, ["safe", "reversible", "irreversible"]);
  assert.ok(shipped.replay.originAllowlist.length, "a deployment allowlist must be stated");
});

test("a missing policy file yields the strict defaults, not an open system", () => {
  // The failure mode that matters: a deployment that forgot to ship a policy must not
  // thereby be granted permission to do anything.
  const policy = loadPolicy(join(scratch, "does-not-exist.json"));
  assert.deepEqual(policy, DEFAULT_POLICY);
  assert.deepEqual(policy.replay.requireApprovalFor, ["safe", "reversible", "irreversible"]);
  assert.deepEqual(policy.redaction.redact, ["identifier", "name", "secret"]);
});

test("a malformed policy is fatal rather than ignored", () => {
  // Silently falling back to defaults would mean a typo in a guardrail reads as
  // "no guardrail", and nobody would find out until it mattered.
  const path = writePolicy("broken.json", { version: 1, replay: { recoveryBudget: "three" } });
  assert.throws(() => loadPolicy(path), PolicyInvalid);
});

test("an unknown risk class is rejected rather than quietly dropped", () => {
  const path = writePolicy("typo.json", { version: 1, replay: { requireApprovalFor: ["irreversable"] } });
  assert.throws(() => loadPolicy(path), PolicyInvalid);
});

// --- risk is derived, never declared twice ---------------------------------

test("a capability is as risky as its riskiest step", () => {
  const a = load();
  assert.equal(capabilityRisk(a), "safe", "a read-only lookup commits nothing");

  const mutating = load();
  mutating.steps[3]!.effect = "irreversible_mutation";
  mutating.steps[3]!.risk = "irreversible";
  assert.equal(capabilityRisk(mutating), "irreversible",
    "one committing step makes the whole capability irreversible");
});

// --- the gate is a policy decision, not a code path ------------------------

test("dropping a risk class from the policy ungates exactly that class", () => {
  const strict = loadPolicy(writePolicy("strict.json", { version: 1 }));
  const relaxed = loadPolicy(
    writePolicy("relaxed.json", {
      version: 1,
      replay: { requireApprovalFor: ["reversible", "irreversible"] },
    }),
  );

  const lookup = load();
  const transfer = load();
  transfer.steps[3]!.effect = "irreversible_mutation";
  transfer.steps[3]!.risk = "irreversible";

  assert.equal(requiresApproval(strict, lookup), true);
  assert.equal(requiresApproval(relaxed, lookup), false, "a read-only lookup is ungated");
  // The half that must never move: loosening the safe class must not loosen the
  // class that moves money.
  assert.equal(requiresApproval(relaxed, transfer), true);
});

test("an empty deployment allowlist defers to the artifact instead of denying all", () => {
  const open = loadPolicy(writePolicy("open.json", { version: 1, replay: { originAllowlist: [] } }));
  assert.equal(originPermitted(open, "https://anything.example/x"), true);

  const bound = loadPolicy(
    writePolicy("bound.json", { version: 1, replay: { originAllowlist: ["http://localhost:8080"] } }),
  );
  assert.equal(originPermitted(bound, "http://localhost:8080/parabank/index.htm"), true);
  assert.equal(originPermitted(bound, "http://evil.example/parabank/index.htm"), false);
});

test("narrowing the discovery vocabulary needs no prompt change", () => {
  const readOnly = loadPolicy(
    writePolicy("readonly.json", {
      version: 1,
      discovery: { allowedActions: ["read", "done", "stuck"] },
    }),
  );
  assert.equal(actionPermitted(readOnly, "read"), true);
  assert.equal(actionPermitted(readOnly, "click"), false);
  assert.equal(actionPermitted(readOnly, "fill"), false);
});

// --- masking ---------------------------------------------------------------

test("a value is masked wherever it appears, not only in the answer", () => {
  const mask = makeMasker([{ name: "accountId", value: "13122" }]);
  assert.equal(
    mask('{"text":"Account 13122 balance","url":"/x?id=13122"}'),
    '{"text":"Account [accountId:redacted] balance","url":"/x?id=[accountId:redacted]"}',
  );
});

test("a value is not matched inside a longer one", () => {
  // The bug this prevents: masking account 131 out of the middle of account 13122,
  // producing evidence that reads as a different account entirely.
  const mask = makeMasker([{ name: "accountId", value: "131" }]);
  assert.equal(mask("131 and 13122"), "[accountId:redacted] and 13122");
});

test("a value bounded by punctuation still masks", () => {
  // \b would silently never fire here: there is no word boundary before "$".
  const mask = makeMasker([{ name: "amount", value: "$100.00" }]);
  assert.equal(mask("Amount: $100.00 sent"), "Amount: [amount:redacted] sent");
});

test("a value too short to identify anyone is left alone", () => {
  // Replacing "5" everywhere would corrupt the evidence while protecting nothing.
  const mask = makeMasker([{ name: "n", value: "5" }, { name: "id", value: "13122" }]);
  assert.equal(mask("5 of 15, account 13122"), "5 of 15, account [id:redacted]");
});

test("which values are masked comes from the artifact's own pii tags", () => {
  const spec = load().signature.inputs;
  assert.equal(spec.accountId?.pii, "identifier");

  const strict = loadPolicy(writePolicy("mask-on.json", { version: 1 }));
  assert.deepEqual(
    maskedInputs(strict, spec, { accountId: "13122" }),
    [{ name: "accountId", value: "13122" }],
  );

  // A field tagged pii: "none" is not regulated data and stays legible.
  assert.deepEqual(maskedInputs(strict, { note: { pii: "none" } }, { note: "hello" }), []);

  // And the policy decides which tags count, so the tags alone are not the whole rule.
  const off = loadPolicy(writePolicy("mask-off.json", { version: 1, redaction: { redact: ["secret"] } }));
  assert.equal(redacts(off, "identifier"), false);
  assert.deepEqual(maskedInputs(off, spec, { accountId: "13122" }), []);
});

test("the recorder masks everything it writes, including nested observations", () => {
  const recorder = new Recorder(scratch, "unit");
  recorder.setMask(makeMasker([{ name: "accountId", value: "13122" }]));

  recorder.log("acted", { url: "/overview.htm?id=13122" });
  recorder.write("trace.json", {
    params: { accountId: "13122" },
    trace: [{ before: { text: "Balance for 13122", nodes: [{ name: "13122" }] } }],
  });

  const written = readdirSync(recorder.dir)
    .map((f) => readFileSync(join(recorder.dir, f), "utf8"))
    .join("\n");
  assert.doesNotMatch(written, /13122/, "an account number reached disk");
  assert.match(written, /\[accountId:redacted\]/);
});

test("a value preceded by an escape sequence is still masked", () => {
  // Regression, found on a live probe run. Masking the serialised JSON rather than
  // the values leaves "…\n13122" with the letter n before the number, so the
  // boundary guard correctly refuses to match and the value reaches disk. The
  // observation text of any real page is full of newlines, so this was not an edge
  // case — result.json came out clean and success.json did not.
  const recorder = new Recorder(scratch, "escapes");
  recorder.setMask(makeMasker([{ name: "accountId", value: "13122" }]));
  recorder.write("obs.json", { text: "Accounts Overview\n13122\t$1,100.00" });

  const written = readFileSync(join(recorder.dir, "obs.json"), "utf8");
  assert.doesNotMatch(written, /13122/);
  assert.match(written, /Accounts Overview\\n\[accountId:redacted\]/);
});

// --- the policy is load-bearing, end to end --------------------------------

let driver: WebDriver;
const evidenceRoot = mkdtempSync(join(tmpdir(), "cua-policy-evidence-"));

before(async () => {
  process.env.OPERATOR_USERNAME ??= "john";
  process.env.OPERATOR_PASSWORD ??= "demo";
  driver = new WebDriver({});
  await driver.launch();
});
after(async () => {
  await driver.close();
  resetPolicyCache();
});

test("one line of JSON decides whether an unapproved capability runs", async () => {
  const artifact = load(); // draft, never approved
  const strict: Policy = loadPolicy(writePolicy("e2e-strict.json", { version: 1 }));
  const relaxed: Policy = loadPolicy(
    writePolicy("e2e-relaxed.json", {
      version: 1,
      replay: { requireApprovalFor: ["reversible", "irreversible"] },
    }),
  );

  const blocked = await replay({
    artifact, inputs: { accountId: "13122" }, driver, evidenceRoot, policy: strict,
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.status === "blocked" && blocked.policyRule, "approval-required");

  // Same artifact, same inputs, same code — different policy file.
  const ran = await replay({
    artifact, inputs: { accountId: "13122" }, driver, evidenceRoot, policy: relaxed,
  });
  assert.equal(ran.status, "success", JSON.stringify(ran, null, 2));
});

test("the deployment allowlist refuses an artifact pointed at the wrong host", async () => {
  const policy = loadPolicy(
    writePolicy("e2e-elsewhere.json", {
      version: 1,
      replay: {
        requireApprovalFor: [],
        originAllowlist: ["https://core.other-bank.example"],
      },
    }),
  );
  const result = await replay({
    artifact: load(), inputs: { accountId: "13122" }, driver, evidenceRoot, policy,
  });
  // The artifact's own allowlist permits this entry; the deployment's does not. That
  // is the whole point of the second layer.
  assert.equal(result.status, "blocked");
  assert.equal(result.status === "blocked" && result.policyRule, "policy-origin-allowlist");
});

test("a real run leaves no account number on disk", async () => {
  const policy = loadPolicy(writePolicy("e2e-mask.json", { version: 1, replay: { requireApprovalFor: [] } }));
  const result = await replay({
    artifact: load(), inputs: { accountId: "13122" }, driver, evidenceRoot, policy,
  });
  assert.equal(result.status, "success", JSON.stringify(result, null, 2));

  // The caller got the real sentence — redacting that would break the product.
  assert.match(result.status === "success" ? (result.answer ?? "") : "", /13122/);

  const written = readFileSync(join(result.evidenceDir, "result.json"), "utf8");
  assert.doesNotMatch(written, /13122/, "the persisted copy still names the account");
  assert.match(written, /\[accountId:redacted\]/);
});

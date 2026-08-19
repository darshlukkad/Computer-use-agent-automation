/**
 * The capability artifact — a typed, versioned, reviewable contract.
 *
 * Three audiences, all served by one document:
 *   - the replay engine, which needs unambiguous instructions
 *   - a calling AI agent, which needs a typed input/output contract
 *   - a human reviewer, for whom "this looks wrong" must be possible in a PR
 *
 * HARD RULE: no application-specific literal ever enters this schema. Everything
 * about a particular app lives in JSON data. A schema that says
 * `title: z.literal("Legacy Member Services")` cannot describe a second app, which
 * makes any multi-tenant claim fiction.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Locators — the ladder
// ---------------------------------------------------------------------------

/**
 * Ordered best-first. Rungs 1-4 describe what a human operator perceives and have
 * direct OS-accessibility equivalents, so they port to desktop surfaces. Rung 5
 * depends on identifiers a developer assigned: web-only, and firing it is recorded
 * as a drift signal rather than treated as normal.
 */
export const LocatorStrategy = z.discriminatedUnion("kind", [
  // rung 1 — accessibility role + name.        desktop: UIA ControlType + Name
  z.object({ kind: z.literal("role_name"), role: z.string(), name: z.string() }),
  // rung 2 — associated <label>.               desktop: UIA LabeledBy
  z.object({ kind: z.literal("label"), text: z.string() }),
  // rung 3 — spatial relation to visible text. desktop: UIA spatial navigation
  z.object({
    kind: z.literal("nearby_text"),
    text: z.string(),
    direction: z.enum(["below", "right", "above", "left"]).default("below"),
  }),
  // rung 4 — cell under a column header.       desktop: UIA Grid/Table pattern
  z.object({
    kind: z.literal("table_cell"),
    header: z.string(),
    /** Row selector; may interpolate `${inputs.*}`. */
    rowMatch: z.string().optional(),
  }),
  // rung 5 — LAST RESORT. web only. no desktop equivalent.
  z.object({ kind: z.literal("css"), selector: z.string() }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const Target = z.object({
  /** The ladder. Order is meaningful: index 0 is rung 1. */
  strategies: z.array(LocatorStrategy).min(1).max(6),
  /**
   * Which rung actually resolved this control when the artifact was recorded.
   * Drift is measured against THIS, not against rung 1.
   *
   * Without it, any target carrying aspirational upper rungs reports drift on every
   * healthy run. ParaBank's login fields are the case in point: `role_name` and
   * `label` resolve to zero elements there and always will, so the step resolves at
   * rung 3 forever. Baseline 3 means silence; rung 4 would mean something changed.
   *
   * Required, not defaulted — a wrong default reintroduces exactly the false
   * positive this field exists to prevent. The compiler records what it observed.
   */
  baselineRung: z.number().int().min(1).max(6),
  /**
   * Why this identification is expected to be stable. Never executed — it exists
   * because a reviewer must be able to judge a fragile-looking locator, and that
   * reasoning decays if it lives in a separate document.
   */
  rationale: z.string().default(""),
});
export type Target = z.infer<typeof Target>;

// ---------------------------------------------------------------------------
// Conditions — a closed, composable DSL
// ---------------------------------------------------------------------------

/**
 * Closed on purpose: no expressions, no eval. An artifact is data that cannot
 * execute code, so the worst a malicious string can express is "look for this text".
 *
 * Composable because real applications emit ambiguous signals. ParaBank renders
 * byte-identical text for a validation error and an expired session, so telling
 * them apart requires `all: [text_present(...), text_absent(...)]`.
 *
 * String fields may interpolate `${inputs.*}`, resolved at replay time.
 */
export type Condition =
  | { kind: "visible"; target: Target }
  | { kind: "text_present"; text: string }
  | { kind: "text_absent"; text: string }
  | { kind: "url_contains"; value: string }
  | { kind: "count_at_least"; target: Target; n: number }
  | { kind: "value_equals"; target: Target; value: string }
  /**
   * Proves a field was filled without naming what went into it. Required for
   * secret-valued fills — `value_equals` on a password would write the credential
   * into the artifact, which is exactly what we must never do.
   */
  | { kind: "value_non_empty"; target: Target }
  | { kind: "all"; items: Condition[] }
  | { kind: "any"; items: Condition[] };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("visible"), target: Target }),
    z.object({ kind: z.literal("text_present"), text: z.string() }),
    z.object({ kind: z.literal("text_absent"), text: z.string() }),
    z.object({ kind: z.literal("url_contains"), value: z.string() }),
    z.object({ kind: z.literal("count_at_least"), target: Target, n: z.number().int().min(1) }),
    z.object({ kind: z.literal("value_equals"), target: Target, value: z.string() }),
    z.object({ kind: z.literal("value_non_empty"), target: Target }),
    z.object({ kind: z.literal("all"), items: z.array(Condition).min(1).max(8) }),
    z.object({ kind: z.literal("any"), items: z.array(Condition).min(1).max(8) }),
  ]),
);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const ActionKind = z.enum([
  "navigate", "fill", "click", "select", "read", "wait", "assert",
]);
export type ActionKind = z.infer<typeof ActionKind>;

/** Values are a closed union — never a free-form template, never a secret literal. */
export const ValueExpr = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("param"), name: z.string() }),
  z.object({ kind: z.literal("const"), value: z.string().max(512) }),
  /** Resolved from the environment at run time. The value is never serialized. */
  z.object({ kind: z.literal("secret"), ref: z.string() }),
]);
export type ValueExpr = z.infer<typeof ValueExpr>;

/**
 * What this step does to the world — governs RETRY SAFETY.
 *
 * The case this exists for: a click on "Transfer" whose response is lost. The
 * transfer may already have committed server-side. Retrying blindly moves the money
 * twice, so an irreversible_mutation is never retried regardless of maxAttempts.
 */
export const Effect = z.enum([
  "observation",            // reading only — always safe to repeat
  "idempotent_write",       // filling a field — same result if repeated
  "reversible_mutation",    // changed state, undoable
  "irreversible_mutation",  // money moved. NEVER retry.
]);
export type Effect = z.infer<typeof Effect>;

/** Whether this needs human APPROVAL — a review-time concern, orthogonal to Effect. */
export const Risk = z.enum(["safe", "reversible", "irreversible"]);
export type Risk = z.infer<typeof Risk>;

export const Step = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  action: ActionKind,
  target: Target.optional(),
  value: ValueExpr.optional(),
  effect: Effect,
  risk: Risk,
  precondition: Condition.optional(),
  /**
   * Required on fill/click/select — see assertArtifactSound(). "I clicked so it
   * worked" is the assumption that turns a failed login into typing a password
   * into whatever page happens to be showing.
   */
  postcondition: Condition.optional(),
  timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  /** Honoured only when effect is retry-safe. */
  maxAttempts: z.number().int().min(1).max(5).default(1),
  /** Name of the output this step's read populates. */
  extractTo: z.string().optional(),
  /**
   * What to do when this step cannot be satisfied and no exception rule explains it.
   *
   * `fail` stops with a debuggable error. `escalate` hands the live session to a
   * human instead — right for a step a person could plausibly complete themselves,
   * such as a confirmation that needs sign-off, or a screen that occasionally
   * demands a second factor.
   *
   * Deliberately per-step rather than global: whether a human can help depends
   * entirely on which step is stuck. Declaring it in the artifact keeps that
   * judgement reviewable next to the step it applies to.
   *
   * There is no `skip`. Skipping a step whose checkpoint failed means continuing in
   * a state nothing has verified, which is the one thing checkpoints exist to
   * prevent.
   */
  onError: z.enum(["fail", "escalate"]).default("fail"),
});
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Exceptions — the error taxonomy, as reviewable data
// ---------------------------------------------------------------------------

export const OutcomeClass = z.enum(["business_outcome", "recoverable", "hard_failure"]);
export type OutcomeClass = z.infer<typeof OutcomeClass>;

export const RecoveryPlan = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("dismiss"), target: Target }),
  z.object({ strategy: z.literal("re_login") }),
  z.object({ strategy: z.literal("wait_retry"), waitMs: z.number().int().min(100).max(30_000) }),
]);
export type RecoveryPlan = z.infer<typeof RecoveryPlan>;

export const ExceptionRule = z.object({
  id: z.string(),
  when: Condition,
  class: OutcomeClass,
  /** Stable, caller-facing: ACCOUNT_NOT_FOUND, SESSION_EXPIRED. */
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  recover: RecoveryPlan.optional(),
  /**
   * How to say this outcome to a person. Same templating as `success.answer`.
   * A calling agent still branches on `code`; this is the sentence it can relay.
   */
  answer: z.string().optional(),
  /**
   * False when the compiler PREDICTED this branch from a happy-path run without ever
   * observing it; true once a real run has hit it. An unverified rule is a guess, and
   * a caller relying on the code deserves to know that.
   */
  verified: z.boolean().default(false),
});
export type ExceptionRule = z.infer<typeof ExceptionRule>;

// ---------------------------------------------------------------------------
// The callable contract
// ---------------------------------------------------------------------------

export const FieldSpec = z.object({
  type: z.enum(["string", "number", "money", "boolean"]),
  required: z.boolean().default(true),
  /** Drives redaction automatically, so nobody has to remember to do it. */
  pii: z.enum(["none", "identifier", "name", "secret"]).default("none"),
  /** Validated before a browser is ever opened — the cheapest possible failure. */
  pattern: z.string().optional(),
  /** What a calling agent reads when choosing this capability. */
  description: z.string().default(""),
});
export type FieldSpec = z.infer<typeof FieldSpec>;

/** Money is integer minor units. Float dollars drift by a cent per thousand rows. */
export const Money = z.object({
  currency: z.string().length(3),
  minorUnits: z.number().int(),
});
export type Money = z.infer<typeof Money>;

export const Extraction = z.object({
  output: z.string(),
  /** Step id whose read produced the value. */
  from: z.string(),
});
export type Extraction = z.infer<typeof Extraction>;

// ---------------------------------------------------------------------------
// The artifact
// ---------------------------------------------------------------------------

export const Capability = z.object({
  /** Versions the SCHEMA. metadata.version versions THIS capability. */
  apiVersion: z.literal("cua.capability/v1"),
  kind: z.literal("Capability"),

  metadata: z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: z.enum(["draft", "approved", "deprecated"]).default("draft"),
    title: z.string(),
    description: z.string(),
    /** sha256 over the canonical unsigned artifact; set at approval. */
    digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    approval: z.object({
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      approverId: z.string().min(1),
      approvedAt: z.string(),
    }).optional(),
  }),

  /** Forensics, not contract. Write-once history of where this came from. */
  provenance: z.object({
    discoveryRunId: z.string(),
    model: z.string(),
    createdAt: z.string(),
    runnerVersion: z.string(),
    liveLlm: z.boolean(),
  }),

  /**
   * Which APP this works against — deliberately not which tenant. Fifty institutions
   * running the same vendor product share one artifact plus fifty small overlays.
   */
  compatibility: z.object({
    vendor: z.string(),
    product: z.string(),
    /** semver range; replay refuses to run outside it rather than guessing. */
    versionRange: z.string(),
    /** How to read the running app's version off the surface. */
    detect: Condition.optional(),
  }),

  entry: z.object({
    originAllowlist: z.array(z.string()).min(1),
    path: z.string(),
  }),

  signature: z.object({
    inputs: z.record(z.string(), FieldSpec),
    outputs: z.record(z.string(), FieldSpec),
  }),

  preconditions: z.array(Condition).default([]),
  steps: z.array(Step).min(1).max(60),
  exceptions: z.array(ExceptionRule).default([]),
  success: z.object({
    checkpoint: Condition,
    extract: z.array(Extraction).default([]),
    /**
     * The result stated in plain language, for a person or for an agent relaying it
     * to one. Interpolates `${inputs.*}` and `${outputs.*}`.
     *
     * This belongs in the artifact rather than in a caller, because how a capability
     * phrases its result is part of what it promises — and it is reviewable here
     * alongside the flow, in the same diff. A caller still branches on typed
     * outputs; this is the sentence, not the data.
     */
    answer: z.string().optional(),
  }),
});
export type Capability = z.infer<typeof Capability>;

// ---------------------------------------------------------------------------
// Tenant overlay — a patch, never a fork
// ---------------------------------------------------------------------------

/**
 * 1 base + 200 overlays of ~8 lines, versus 200 forks of 200 lines. A bug fixed in
 * the base reaches every tenant.
 *
 * An overlay may change copy, paths, and locators. It may NEVER change risk, effect,
 * the signature, or an exception's class — otherwise a tenant config file becomes a
 * way to disable the safety model. Enforced in applyOverlay(), not by convention.
 */
export const TenantOverlay = z.object({
  apiVersion: z.literal("cua.overlay/v1"),
  kind: z.literal("TenantOverlay"),
  metadata: z.object({
    id: z.string(),
    tenant: z.string(),
    appliesTo: z.object({
      capabilityId: z.string(),
      versionRange: z.string(),
    }),
    notes: z.string().default(""),
  }),
  /** Must match the base artifact's vendor/product or the merge is refused. */
  compatibility: z.object({ vendor: z.string(), product: z.string() }),
  entryPath: z.string().optional(),
  originAllowlist: z.array(z.string()).optional(),
  /** Label rewrites: "Username" -> "Member Number". Applied to locators and conditions. */
  copy: z.record(z.string(), z.string()).default({}),
  /** Full target override, keyed by step id. */
  locators: z.record(z.string(), Target).default({}),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;

// ---------------------------------------------------------------------------
// Structural lint — rules the type system cannot express
// ---------------------------------------------------------------------------

export class ArtifactInvalid extends Error {}

/** Every Target in the artifact, including ones nested inside conditions. */
export function* targetsOf(a: Capability): Generator<[string, Target]> {
  function* fromCondition(where: string, c: Condition | undefined): Generator<[string, Target]> {
    if (!c) return;
    if (c.kind === "all" || c.kind === "any") {
      for (const item of c.items) yield* fromCondition(where, item);
    } else if ("target" in c) {
      yield [where, c.target];
    }
  }

  for (const c of a.preconditions) yield* fromCondition("preconditions", c);
  for (const s of a.steps) {
    if (s.target) yield [`step '${s.id}'`, s.target];
    yield* fromCondition(`step '${s.id}' precondition`, s.precondition);
    yield* fromCondition(`step '${s.id}' postcondition`, s.postcondition);
  }
  for (const r of a.exceptions) {
    yield* fromCondition(`exception '${r.id}'`, r.when);
    if (r.recover?.strategy === "dismiss") yield [`exception '${r.id}' recovery`, r.recover.target];
  }
  yield* fromCondition("success.checkpoint", a.success.checkpoint);
}

/**
 * Checks that survive `Capability.parse()` but still make an artifact unsound.
 * Runs at load time, before a browser is opened.
 */
export function assertArtifactSound(a: Capability): void {
  const fail = (m: string): never => {
    throw new ArtifactInvalid(`${a.metadata.id}: ${m}`);
  };

  const ids = new Set<string>();
  for (const s of a.steps) {
    if (ids.has(s.id)) fail(`duplicate step id '${s.id}'`);
    ids.add(s.id);

    // A mutation with no proof it landed is "I clicked, therefore it worked".
    if ((s.action === "fill" || s.action === "click" || s.action === "select") && !s.postcondition) {
      fail(`step '${s.id}' mutates but declares no postcondition`);
    }
    if (s.action !== "navigate" && s.action !== "wait" && !s.target) {
      fail(`step '${s.id}' (${s.action}) needs a target`);
    }
    if (s.action === "read" && !s.extractTo) {
      fail(`step '${s.id}' reads but declares no extractTo`);
    }
    // Retrying a committed action is how you transfer money twice.
    if (s.maxAttempts > 1 && s.effect !== "observation" && s.effect !== "idempotent_write") {
      fail(`step '${s.id}' has maxAttempts=${s.maxAttempts} but effect '${s.effect}' is not retry-safe`);
    }
  }

  // A baseline pointing past the end of the ladder can never be satisfied.
  for (const [stepId, t] of targetsOf(a)) {
    if (t.baselineRung > t.strategies.length) {
      fail(`${stepId}: baselineRung ${t.baselineRung} exceeds its ${t.strategies.length}-rung ladder`);
    }
  }

  for (const r of a.exceptions) {
    if (r.class === "recoverable" && !r.recover) {
      fail(`exception '${r.id}' is recoverable but declares no recovery plan`);
    }
    if (r.class !== "recoverable" && r.recover) {
      fail(`exception '${r.id}' is '${r.class}' but declares a recovery plan`);
    }
  }

  for (const e of a.success.extract) {
    if (!ids.has(e.from)) fail(`success.extract references unknown step '${e.from}'`);
    if (!(e.output in a.signature.outputs)) {
      fail(`success.extract produces '${e.output}', absent from signature.outputs`);
    }
  }

  // Every ${inputs.x} anywhere in the artifact must be a declared input. The compiler
  // can otherwise emit a success condition referring to a parameter that does not
  // exist, which replay would silently compare against the literal placeholder.
  const declared = new Set(Object.keys(a.signature.inputs));
  for (const ref of referencedInputs(a)) {
    if (!declared.has(ref)) {
      fail(`references \${inputs.${ref}} but declares no such input`);
    }
  }

  // Every declared output must actually be produced by some extraction.
  for (const name of Object.keys(a.signature.outputs)) {
    if (!a.success.extract.some((e) => e.output === name)) {
      fail(`signature declares output '${name}' that nothing extracts`);
    }
  }

  // Same rule for ${outputs.x}. The answer sentence is the only place these appear,
  // and it is the one field a customer may end up reading, so a placeholder with
  // nothing behind it must not survive review as a visible hole in a sentence.
  const produced = new Set(Object.keys(a.signature.outputs));
  for (const ref of referenced(a, "outputs")) {
    if (!produced.has(ref)) {
      fail(`references \${outputs.${ref}} but declares no such output`);
    }
  }
}

/** Names referenced as ${inputs.x} anywhere in the artifact. */
export function referencedInputs(a: Capability): Set<string> {
  return referenced(a, "inputs");
}

function referenced(a: Capability, bucket: "inputs" | "outputs"): Set<string> {
  const re = new RegExp(`\\$\\{${bucket}\\.([A-Za-z_][A-Za-z0-9_]*)\\}`, "g");
  const found = new Set<string>();
  const scan = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(re)) found.add(m[1]!);
    } else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === "object") Object.values(v).forEach(scan);
  };
  // metadata/provenance are prose and may legitimately mention a placeholder.
  scan({ preconditions: a.preconditions, steps: a.steps, exceptions: a.exceptions, success: a.success });
  return found;
}

export function parseCapability(data: unknown): Capability {
  const a = Capability.parse(data);
  assertArtifactSound(a);
  return a;
}

export function parseOverlay(data: unknown): TenantOverlay {
  return TenantOverlay.parse(data);
}
/**
 * Guardrails as data.
 *
 * Every rule here was previously a literal buried in the code that enforced it: the
 * approval gate inside the replay engine, the origin check next to it, the permitted
 * action set inside the discovery loop. That works, but it means the answer to "what
 * is this system allowed to do?" is only available by reading TypeScript — and the
 * people who most need that answer are the ones who will not read it.
 *
 * So the rules move to one file a reviewer can read in thirty seconds, and the code
 * asks this module instead of deciding for itself. Enforcement stays where it was;
 * only the decision moved.
 *
 * Two layers on purpose. The artifact declares what the *capability* may do (its own
 * origin allowlist, each step's risk); this file declares what the *deployment* will
 * permit. An approved artifact carried to the wrong environment is stopped by the
 * second layer even though it passes the first.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Capability, Risk } from "../artifact/schema.ts";

export const POLICY_PATH = "policy.json";

const RiskName = z.enum(["safe", "reversible", "irreversible"]);

const PolicySchema = z.object({
  version: z.literal(1),
  replay: z
    .object({
      /**
       * Risk classes that may not run without a valid approval.
       *
       * Listing all three — the shipped default — is the conservative stance: nothing
       * runs unattended until a human has signed the exact bytes. Dropping "safe"
       * lets a read-only lookup run unattended while a transfer stays gated, which is
       * the distinction `risk` exists to make. That is a deployment decision, not a
       * code change, which is the entire point of this file.
       */
      requireApprovalFor: z.array(RiskName).default(["safe", "reversible", "irreversible"]),
      /**
       * Origins any capability may enter, on top of the artifact's own allowlist.
       * Empty means "defer entirely to the artifact".
       */
      originAllowlist: z.array(z.string()).default([]),
      /** Total recoveries per run, so a flapping page cannot loop forever. */
      recoveryBudget: z.number().int().min(0).default(3),
    })
    // prefault, not default: an absent section is re-parsed as `{}` so each field's
    // own default applies. `.default({})` would demand a fully-formed section here,
    // duplicating every default in a second place for them to drift apart.
    .prefault({}),
  discovery: z
    .object({
      /**
       * The action vocabulary a discovery run may actually use. The model is told the
       * full set by its tool schema; anything outside this list is refused between the
       * decision and the page, so a narrower run needs no prompt change.
       */
      allowedActions: z
        .array(z.enum(["click", "fill", "select", "read", "done", "stuck"]))
        .default(["click", "fill", "select", "read", "done", "stuck"]),
      maxTurns: z.number().int().min(1).default(14),
    })
    // prefault, not default: an absent section is re-parsed as `{}` so each field's
    // own default applies. `.default({})` would demand a fully-formed section here,
    // duplicating every default in a second place for them to drift apart.
    .prefault({}),
  redaction: z
    .object({
      /**
       * Which `pii` tags are treated as regulated. A value tagged with one of these is
       * masked before anything is written to disk — so the tags in an artifact's
       * signature are load-bearing rather than documentation.
       */
      redact: z.array(z.enum(["identifier", "name", "secret"])).default(["identifier", "name", "secret"]),
    })
    // prefault, not default: an absent section is re-parsed as `{}` so each field's
    // own default applies. `.default({})` would demand a fully-formed section here,
    // duplicating every default in a second place for them to drift apart.
    .prefault({}),
});

export type Policy = z.infer<typeof PolicySchema>;

export class PolicyInvalid extends Error {}

/** Every field defaulted, so a missing policy file is a valid strict policy. */
export const DEFAULT_POLICY: Policy = PolicySchema.parse({ version: 1 });

let cached: { path: string; policy: Policy } | null = null;

/**
 * Read the policy once per path. Absent is not an error — the defaults are the strict
 * stance, so a deployment that forgot to ship a policy file gets the safe one rather
 * than an open one.
 */
export function loadPolicy(path = POLICY_PATH): Policy {
  if (cached?.path === path) return cached.policy;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      cached = { path, policy: DEFAULT_POLICY };
      return DEFAULT_POLICY;
    }
    throw new PolicyInvalid(`${path} is not readable JSON: ${(e as Error).message}`);
  }

  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    // A malformed policy is fatal rather than ignored. Falling back to defaults would
    // silently apply rules nobody wrote, and a typo in a guardrail must not read as
    // "no guardrail".
    throw new PolicyInvalid(`${path} is not a valid policy: ${z.prettifyError(parsed.error)}`);
  }
  cached = { path, policy: parsed.data };
  return parsed.data;
}

/** Tests and the CLI may point at a different file; this clears the memo. */
export function resetPolicyCache(): void {
  cached = null;
}

const SEVERITY: Record<Risk, number> = { safe: 0, reversible: 1, irreversible: 2 };

/**
 * A capability is as risky as its riskiest step.
 *
 * There is no capability-level risk field on purpose: it would be a second place to
 * state the same thing, and the two would drift. A flow that moves money has an
 * irreversible step in it, and that is the fact worth reading.
 */
export function capabilityRisk(artifact: Capability): Risk {
  return artifact.steps.reduce<Risk>(
    (worst, step) => (SEVERITY[step.risk] > SEVERITY[worst] ? step.risk : worst),
    "safe",
  );
}

export function requiresApproval(policy: Policy, artifact: Capability): boolean {
  return policy.replay.requireApprovalFor.includes(capabilityRisk(artifact));
}

/** Empty allowlist defers to the artifact; otherwise the URL must sit under an entry. */
export function originPermitted(policy: Policy, url: string): boolean {
  const allowed = policy.replay.originAllowlist;
  if (!allowed.length) return true;
  return allowed.some((origin) => url.startsWith(origin));
}

export function actionPermitted(policy: Policy, kind: string): boolean {
  return (policy.discovery.allowedActions as string[]).includes(kind);
}

export function redacts(policy: Policy, pii: string | undefined): boolean {
  if (!pii) return false;
  return (policy.redaction.redact as string[]).includes(pii);
}

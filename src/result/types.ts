/**
 * What replay hands back.
 *
 * The brief's glossary singles out one mistake as the most common: conflating a
 * business outcome with a failure. "No such account" is a legitimate answer the
 * caller needs, not a crash. Throwing for it forces every caller to string-match
 * error text to decide between "tell the member" and "page the on-call engineer".
 *
 * So replay NEVER throws for anything it anticipated — it returns one of these. And
 * because it's a discriminated union, `result.outputs` is a compile error until you
 * have proved `status === "success"`. The mistake is rejected by the type checker
 * rather than discouraged by convention.
 */
import type { Effect } from "../artifact/schema.ts";

/** Codes for things that genuinely went wrong. Business outcomes are NOT in here. */
export type FailureCode =
  | "INPUT_VALIDATION"      // params failed signature.inputs — no browser opened
  | "ARTIFACT_INVALID"      // failed schema or structural lint
  | "ARTIFACT_TAMPERED"     // approved digest does not match content
  | "INCOMPATIBLE_APP"      // running app outside compatibility.versionRange
  | "TARGET_MISSING"        // ladder exhausted, zero matches
  | "TARGET_AMBIGUOUS"      // >1 match; we refuse to guess
  | "PRECONDITION_FAILED"
  | "POSTCONDITION_FAILED"
  | "CHECKPOINT_MISMATCH"   // success condition never held
  | "TIMEOUT"
  | "OUTPUT_VALIDATION"     // extracted values failed signature.outputs
  | "INTERNAL";

/**
 * Whether the ladder resolved where it used to.
 *
 * Deliberately NOT "did we fall past rung 1" — a target may legitimately carry
 * aspirational upper rungs that never match. Measured against the recorded
 * baseline, so a step that has always resolved at rung 3 stays silent, and only a
 * genuine change speaks.
 */
export type Drift = "none" | "degraded" | "improved";

export function classifyDrift(baselineRung: number, resolvedRung: number | null): Drift {
  if (resolvedRung === null || resolvedRung === baselineRung) return "none";
  return resolvedRung > baselineRung ? "degraded" : "improved";
}

/**
 * Per-step telemetry. Carries the drift signal every peer submission described in
 * prose and none of them recorded — nearly free, since the resolver already knows
 * which rung it used.
 */
export interface StepTrace {
  stepId: string;
  action: string;
  /** 1-based index into the ladder; null if the step had no target. */
  resolvedRung: number | null;
  /** What the artifact recorded at compile time; null if the step had no target. */
  baselineRung: number | null;
  strategy: string | null;
  drift: Drift;
  attempts: number;
  durationMs: number;
  /**
   * `skipped` means the page already satisfied this step's postcondition when the run
   * resumed, so it was not executed — a person had done it during a handoff. Recorded
   * rather than omitted: a trace that silently lacks the login steps is indistinguishable
   * from a run that never logged in.
   */
  outcome: "ok" | "recovered" | "failed" | "skipped";
}

/** A condition we handled and continued past. Reported, never swallowed. */
export interface Recovery {
  stepId: string;
  attempt: number;
  /** Exception rule code, e.g. SESSION_EXPIRED. */
  code: string;
  action: string;
}

interface Base {
  capabilityId: string;
  capabilityVersion: string;
  tenant: string | null;
  durationMs: number;
  evidenceDir: string;
}

export type ReplayResult =
  /** Goal achieved. `recoveries` says whether anything went wrong on the way. */
  | (Base & {
      status: "success";
      outputs: Record<string, unknown>;
      /**
       * The result in plain language, rendered from the artifact's own template.
       * Present so a calling agent has something to relay to a member without
       * inventing phrasing of its own. Typed `outputs` remain the data; this is
       * the sentence. Absent when the artifact declares no template.
       */
      answer?: string;
      recoveries: Recovery[];
      trace: StepTrace[];
    })
  /**
   * The automation worked; the answer is negative. `code` comes from the artifact's
   * reviewed exception rules, so a caller branches on a constant, never on prose.
   */
  | (Base & {
      status: "business_outcome";
      code: string;
      /** Same as above: the outcome stated for a person, from the rule's template. */
      answer?: string;
      observed: string;
      recoveries: Recovery[];
      trace: StepTrace[];
    })
  /**
   * Paused, not dead. The browser session is alive and a human can take over; the
   * run may still complete. Distinct lifecycle from a failure.
   */
  | (Base & {
      status: "intervention_required";
      interventionId: string;
      code: string;
      reason: string;
      stepId: string;
      trace: StepTrace[];
    })
  /**
   * We refused — policy, or an unapproved irreversible capability. Nothing was
   * attempted. Separate from `failure` because the remedy differs: get approval,
   * versus go debug something.
   */
  | (Base & {
      status: "blocked";
      policyRule: string;
      reason: string;
    })
  /** We tried and could not finish. Carries enough to debug without reproducing. */
  | (Base & {
      status: "failure";
      code: FailureCode;
      stepId: string | null;
      expected: string;
      observed: string;
      /**
       * Derived from the step's Effect, never guessed. False after a click that may
       * already have committed — the money may have moved, so do not retry.
       */
      safeToRetry: boolean;
      trace: StepTrace[];
    });

export type ReplayStatus = ReplayResult["status"];

/** Retry safety is a property of what the action does to the world. */
export function isRetrySafe(effect: Effect): boolean {
  return effect === "observation" || effect === "idempotent_write";
}

export interface DiscoveryResult {
  status: "success" | "stuck" | "blocked" | "failed";
  goal: string;
  capabilityId?: string;
  artifactPath?: string;
  interventionId?: string;
  modelCalls: number;
  steps: number;
  stopReason: string;
  evidenceDir: string;
}

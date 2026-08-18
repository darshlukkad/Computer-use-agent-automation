/**
 * Deciding what a stuck replay actually means.
 *
 * The brief names conflating a business outcome with a failure as the most common
 * design mistake here, so the ordering is a structural guarantee rather than a
 * convention: EVERY matching exception rule is evaluated, then the winner is chosen
 * by class priority.
 *
 *     business_outcome  >  recoverable  >  hard_failure
 *
 * First-match-wins would make correctness depend on the order rules happen to sit
 * in a JSON file, and a reordering during review could silently turn "no such
 * account" into a crash. Priority selection cannot be broken that way.
 */
import type { Capability, ExceptionRule, RecoveryPlan } from "../artifact/schema.ts";
import { EvalContext, evaluate } from "./conditions.ts";

export type Classification =
  | { class: "business_outcome"; rule: ExceptionRule; code: string; observed: string }
  | { class: "recoverable"; rule: ExceptionRule; code: string; recover: RecoveryPlan }
  /** Nothing matched, or the only matches were declared hard failures. */
  | { class: "hard_failure"; rule?: ExceptionRule; code?: string; observed: string };

const PRIORITY = { business_outcome: 0, recoverable: 1, hard_failure: 2 } as const;

export async function classify(
  ctx: EvalContext,
  artifact: Capability,
): Promise<Classification> {
  const matched: ExceptionRule[] = [];
  for (const rule of artifact.exceptions) {
    ctx.invalidate();
    if (await evaluate(ctx, rule.when)) matched.push(rule);
  }

  const observed = summarize((await ctx.observation()).text);

  if (matched.length === 0) {
    return { class: "hard_failure", observed };
  }

  matched.sort((a, b) => PRIORITY[a.class] - PRIORITY[b.class]);
  const winner = matched[0]!;

  switch (winner.class) {
    case "business_outcome":
      return { class: "business_outcome", rule: winner, code: winner.code, observed };
    case "recoverable":
      // Structural lint guarantees a recoverable rule carries a plan.
      return { class: "recoverable", rule: winner, code: winner.code, recover: winner.recover! };
    case "hard_failure":
      return { class: "hard_failure", rule: winner, code: winner.code, observed };
  }
}

/** A compact, redaction-friendly slice of what was on screen. */
function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Whether a recovery may run at all.
 *
 * `re_login` restarts the flow from the top, which is only safe if nothing already
 * executed has committed anything. Re-running a completed transfer to recover from
 * an expired session would move the money twice — so when any prior step is not
 * retry-safe the recovery is refused and the run escalates to a human instead.
 * A recovery that can cause the harm it is recovering from is not a recovery.
 */
export function recoveryPermitted(
  plan: RecoveryPlan,
  artifact: Capability,
  currentStepIndex: number,
): { permitted: true } | { permitted: false; reason: string } {
  if (plan.strategy !== "re_login") return { permitted: true };

  const committed = artifact.steps
    .slice(0, currentStepIndex)
    .filter((s) => s.effect === "reversible_mutation" || s.effect === "irreversible_mutation");

  if (committed.length > 0) {
    return {
      permitted: false,
      reason:
        `re_login would replay ${committed.map((s) => s.id).join(", ")}, ` +
        `which already committed (${committed[0]!.effect})`,
    };
  }
  return { permitted: true };
}

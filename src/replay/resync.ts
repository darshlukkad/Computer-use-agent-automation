/**
 * Where to pick up after a person has been driving.
 *
 * Resuming at the step that failed is wrong, and it is the obvious thing to do. The
 * human took control *because* that step could not proceed; if they cleared the
 * blocker by completing the work themselves — signing in, filling the form, dismissing
 * whatever was in the way — replaying that step means doing it twice. On a transfer
 * screen, twice means twice.
 *
 * So the resume point is read off the page rather than remembered: walk forward from
 * where the run stopped, skipping any step whose postcondition already holds, and start
 * at the first one that does not.
 *
 * Two rules make this safe rather than clever:
 *
 *   - Never resume EARLIER than where the run stopped. An earlier step's postcondition
 *     will often be unmet simply because the flow has moved past it — a login field's
 *     `value_equals` cannot hold once the login screen is gone. Scanning from the start
 *     would "helpfully" try to re-fill a field that no longer exists.
 *   - Only skip a step that has a postcondition. A step with nothing to check has not
 *     been proved done, and a `read` step must always execute or its output is never
 *     extracted.
 *
 * ponytail: this assumes the human moved the flow forward, never backward or sideways.
 * A person who navigated somewhere unrelated and handed back gets a resume point that
 * is merely plausible. The upgrade path is asserting each skipped step's postcondition
 * still holds at the moment of resumption rather than once, which costs a re-scan; for
 * a take-home, the honest mitigation is that the handback is refused outright when
 * nothing changed, and every skipped step is named in the result.
 */
import type { Capability } from "../artifact/schema.ts";
import { evaluate, type EvalContext } from "./conditions.ts";

export interface ResumePlan {
  /** Index into artifact.steps to start executing at. */
  index: number;
  /** Steps skipped because the page already satisfies them. */
  skipped: string[];
  /**
   * The success checkpoint already holds — the operator finished the job.
   *
   * Reported, but deliberately NOT used to jump to the end. A `read` step carries no
   * postcondition, so the scan below cannot skip one, and it must not: skipping the
   * reads would leave every declared output unextracted and turn a completed run into
   * an output-validation failure. Reading a value the human produced is safe; it is
   * the mutations that must not repeat, and those are skipped because their
   * postconditions hold.
   */
  complete: boolean;
}

export async function resumePlan(
  ctx: EvalContext,
  artifact: Capability,
  from: number,
): Promise<ResumePlan> {
  const start = Math.max(0, Math.min(from, artifact.steps.length));

  ctx.invalidate();
  const complete = await evaluate(ctx, artifact.success.checkpoint);

  const skipped: string[] = [];
  let index = start;
  while (index < artifact.steps.length) {
    const step = artifact.steps[index]!;
    if (!step.postcondition) break;
    ctx.invalidate();
    if (!(await evaluate(ctx, step.postcondition))) break;
    skipped.push(step.id);
    index += 1;
  }
  return { index, skipped, complete };
}

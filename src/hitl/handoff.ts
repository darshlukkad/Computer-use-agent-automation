/**
 * Pause, cede control, resume — on the same browser.
 *
 * §3.6 asks for this to be a mechanism rather than a TODO, and the part that makes it
 * a mechanism is that control transfer is *checked*, not announced. Three checks, each
 * from a way this goes wrong in practice:
 *
 *   - **Custody is exclusive.** A takeover while the automation still holds the session
 *     is refused, and so is a handback from someone who never took it. Two actors
 *     believing they may act on one screen is how a half-filled transfer form gets
 *     submitted.
 *   - **A handback that changed nothing is refused.** The operator was called because
 *     the run could not proceed; resuming into a byte-identical screen walks into the
 *     same wall, escalates again, and loops. The screen is fingerprinted when control
 *     is taken and again when it is returned.
 *   - **Where to resume is read off the page, not remembered.** The human may have
 *     completed several steps. `resumePlan` decides; this module only reports what it
 *     decided, so the operator sees which steps will be skipped before the run
 *     continues.
 *
 * Nothing here knows what a browser is. It takes a driver, which is how the same
 * handoff would work against a desktop surface.
 */
import type { Capability } from "../artifact/schema.ts";
import type { ReplayResult } from "../result/types.ts";
import { observationDigest, type SurfaceDriver } from "../surface/driver.ts";
import { EvalContext } from "../replay/conditions.ts";
import { resumePlan, type ResumePlan } from "../replay/resync.ts";
import { transferControl, writeSession, type SessionRecord } from "../session/registry.ts";

export class HandoffRefused extends Error {}

/**
 * Where a run stopped, as an index.
 *
 * The result contract carries a step id rather than an index, because an id survives
 * an artifact being reordered and an index does not. `"success"` is the id the engine
 * uses when it was the final checkpoint that would not hold, which means every step
 * ran — so the resume floor is the end of the list.
 */
export function stepIndexOf(artifact: Capability, stepId: string): number {
  if (stepId === "success") return artifact.steps.length;
  const i = artifact.steps.findIndex((s) => s.id === stepId);
  return i === -1 ? 0 : i;
}

/** Attach an intervention to the session, so a later process can pick it up. */
export function pause(
  record: SessionRecord,
  artifact: Capability,
  result: Extract<ReplayResult, { status: "intervention_required" }>,
  inputs: Record<string, string>,
  tenant: string | null,
): SessionRecord {
  record.pending = {
    capabilityId: artifact.metadata.id,
    interventionId: result.interventionId,
    stepId: result.stepId,
    stepIndex: stepIndexOf(artifact, result.stepId),
    reason: result.reason,
    inputs,
    tenant,
    evidenceDir: result.evidenceDir,
  };
  writeSession(record);
  return record;
}

export async function takeover(
  record: SessionRecord,
  driver: SurfaceDriver,
  actor: string,
): Promise<{ record: SessionRecord; fingerprint: string; url: string }> {
  if (record.owner === "human") {
    const holder = record.actors.at(-1)?.actor ?? "someone";
    throw new HandoffRefused(
      `${holder} already holds session ${record.id}. Two people on one screen is how a ` +
      `half-completed form gets submitted; wait for a handback.`,
    );
  }
  if (!record.pending) {
    throw new HandoffRefused(
      `session ${record.id} has no run waiting for a person. Taking control of an idle ` +
      `session would leave nothing to hand back to.`,
    );
  }

  const observation = await driver.observe();
  const fingerprint = observationDigest(observation);
  return {
    record: transferControl(record, { actor, role: "human" }, fingerprint),
    fingerprint,
    url: observation.url,
  };
}

export interface Handback {
  record: SessionRecord;
  plan: ResumePlan;
  /** What actually changed while the person held the session. */
  changed: boolean;
}

export async function handback(
  record: SessionRecord,
  driver: SurfaceDriver,
  artifact: Capability,
  opts: { actor: string; note?: string; force?: boolean },
): Promise<Handback> {
  if (record.owner !== "human") {
    throw new HandoffRefused(
      `session ${record.id} is not held by a person, so there is nothing to hand back.`,
    );
  }
  const turn = record.actors.at(-1)!;
  if (turn.actor !== opts.actor && !opts.force) {
    // Not security — this runs on the operator's own machine. It catches the ordinary
    // mistake of two people working the same queue and typing the wrong session id.
    throw new HandoffRefused(
      `session ${record.id} is held by ${turn.actor}, not ${opts.actor}. ` +
      `Pass --force if you are taking it back on their behalf.`,
    );
  }
  if (!record.pending) {
    throw new HandoffRefused(`session ${record.id} has no run to resume.`);
  }

  const observation = await driver.observe();
  const fingerprint = observationDigest(observation);
  const changed = fingerprint !== turn.fingerprintBefore;

  if (!changed && !opts.force) {
    throw new HandoffRefused(
      `the screen is unchanged since you took control, so resuming would stop at the ` +
      `same point and ask again. Either act on the page, or pass --force to resume ` +
      `anyway and record that nothing was done.`,
    );
  }

  // What the run will actually do next, computed before control returns so the operator
  // can disagree with it while they still hold the session.
  const ctx = new EvalContext(driver, record.pending.inputs);
  const plan = await resumePlan(ctx, artifact, record.pending.stepIndex);

  return {
    record: transferControl(record, { actor: "automation", role: "automation" }, fingerprint, opts.note),
    plan,
    changed,
  };
}
